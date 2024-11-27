(function () {
	'use strict';

	var hasOwn = {}.hasOwnProperty;

	var invokeRedrawable = async (redraw, fn, thisValue, ...args) => {
		if (typeof fn === "function") {
			thisValue = Reflect.apply(fn, thisValue, args);
			if (thisValue === "skip-redraw") return
			if (thisValue && typeof thisValue.then === "function" && (await thisValue) === "skip-redraw") return
			redraw();
		}
	};

	var checkCallback = (callback, allowNull, label = "callback") => {
		if (allowNull && callback == null || typeof callback === "function") {
			return callback
		}

		throw new TypeError(`\`${label}\` must be a function${allowNull ? " if provided." : "."}`)
	};

	var noop = () => {};

	/* eslint-disable no-bitwise */

	/*
	Caution: be sure to check the minified output. I've noticed an issue with Terser trying to inline
	single-use functions as IIFEs, and this predictably causes perf issues since engines don't seem to
	reliably lower this in either their bytecode generation *or* their optimized code.

	Rather than painfully trying to reduce that to an MVC and filing a bug against it, I'm just
	inlining and commenting everything. It also gives me a better idea of the true cost of various
	functions.

	In `m`, I do use a no-inline hints (the `__NOINLINE__` in an inline block comment there) to
	prevent Terser from inlining a cold function in a very hot code path, to try to squeeze a little
	more performance out of the framework. Likewise, to try to preserve this through build scripts,
	Terser annotations are preserved in the ESM production bundle (but not the UMD bundle).

	Also, be aware: I use some bit operations here. Nothing super fancy like find-first-set, just
	mainly ANDs, ORs, and a one-off XOR for inequality.
	*/

	/*
	State note:

	If remove on throw is `true` and an error occurs:
	- All visited vnodes' new versions are removed.
	- All unvisited vnodes' old versions are removed.

	If remove on throw is `false` and an error occurs:
	- Attribute modification errors are logged.
	- Views that throw retain the previous version and log their error.
	- Errors other than the above cause the tree to be torn down as if remove on throw was `true`.
	*/

	/*
	This same structure is used for several nodes. Here's an explainer for each type.

	Retain:
	- `m`: `-1`
	- All other properties are unused
	- On ingest, the vnode itself is converted into the type of the element it's retaining. This
	  includes changing its type.

	Fragments:
	- `m` bits 0-3: `0`
	- `t`: unused
	- `s`: unused
	- `a`: unused
	- `c`: virtual DOM children
	- `d`: unused

	Keyed:
	- `m` bits 0-3: `1`
	- `t`: unused
	- `s`: unused
	- `a`: key to child map, also holds children
	- `c`: unused
	- `d`: unused

	Text:
	- `m` bits 0-3: `2`
	- `t`: unused
	- `s`: unused
	- `a`: text string
	- `c`: unused
	- `d`: abort controller reference

	Components:
	- `m` bits 0-3: `3`
	- `t`: component reference
	- `s`: view function, may be same as component reference
	- `a`: most recently received attributes
	- `c`: instance vnode
	- `d`: unused

	DOM elements:
	- `m` bits 0-3: `4`
	- `t`: tag name string
	- `s`: event listener dictionary, if any events were ever registered
	- `a`: most recently received attributes
	- `c`: virtual DOM children
	- `d`: element reference

	Layout:
	- `m` bits 0-3: `5`
	- `t`: unused
	- `s`: uncaught
	- `a`: callback to schedule
	- `c`: unused
	- `d`: parent DOM reference, for easier queueing

	Remove:
	- `m` bits 0-3: `6`
	- `t`: unused
	- `s`: unused
	- `a`: callback to schedule
	- `c`: unused
	- `d`: parent DOM reference, for easier queueing

	Set context:
	- `m` bits 0-3: `7`
	- `t`: unused
	- `s`: unused
	- `a`: unused
	- `c`: virtual DOM children
	- `d`: unused

	Use dependencies:
	- `m` bits 0-3: `8`
	- `t`: unused
	- `s`: unused
	- `a`: Dependency array
	- `c`: virtual DOM children
	- `d`: unused

	Inline:
	- `m` bits 0-3: `8`
	- `t`: unused
	- `s`: unused
	- `a`: view function
	- `c`: instance vnode
	- `d`: unused

	The `m` field is also used for various assertions, that aren't described here.
	*/

	var TYPE_MASK = 15;
	var TYPE_RETAIN = -1;
	var TYPE_FRAGMENT = 0;
	var TYPE_KEYED = 1;
	var TYPE_TEXT = 2;
	var TYPE_ELEMENT = 3;
	var TYPE_COMPONENT = 4;
	var TYPE_LAYOUT = 5;
	var TYPE_REMOVE = 6;
	var TYPE_SET_CONTEXT = 7;
	var TYPE_USE = 8;
	var TYPE_INLINE = 9;
	// var TYPE_RETAIN = 15

	var FLAG_USED = 1 << 4;
	var FLAG_IS_REMOVE = 1 << 5;
	var FLAG_HTML_ELEMENT = 1 << 6;
	var FLAG_CUSTOM_ELEMENT = 1 << 7;
	var FLAG_INPUT_ELEMENT = 1 << 8;
	var FLAG_SELECT_ELEMENT = 1 << 9;
	var FLAG_OPTION_ELEMENT = 1 << 10;
	var FLAG_TEXTAREA_ELEMENT = 1 << 11;
	var FLAG_IS_FILE_INPUT = 1 << 12;
	// Implicitly used as part of checking for `m.retain()`.
	// var FLAG_IS_RETAIN = 1 << 31

	var Vnode = (mask, tag, attrs, children) => ({
		m: mask,
		t: tag,
		a: attrs,
		c: children,
		s: null,
		d: null,
	});

	var selectorParser = /(?:(^|#|\.)([^#\.\[\]]+))|(\[(.+?)(?:\s*=\s*("|'|)((?:\\["'\]]|.)*?)\5)?\])/g;
	var selectorUnescape = /\\(["'\\])/g;
	var selectorCache = /*@__PURE__*/ new Map();

	var compileSelector = (selector) => {
		var match, tag = "div", classes = [], attrs = {}, className, hasAttrs = false;

		while (match = selectorParser.exec(selector)) {
			var type = match[1], value = match[2];
			if (type === "" && value !== "") {
				tag = value;
			} else {
				hasAttrs = true;
				if (type === "#") {
					attrs.id = value;
				} else if (type === ".") {
					classes.push(value);
				} else if (match[3][0] === "[") {
					var attrValue = match[6];
					if (attrValue) attrValue = attrValue.replace(selectorUnescape, "$1");
					if (match[4] === "class" || match[4] === "className") classes.push(attrValue);
					else attrs[match[4]] = attrValue == null || attrValue;
				}
			}
		}

		if (classes.length > 0) {
			className = classes.join(" ");
		}

		var state = {t: tag, a: hasAttrs ? attrs : null, c: className};
		selectorCache.set(selector, state);
		return state
	};

	/*
	Edit this with caution and profile every change you make. This comprises about 4% of the total
	runtime overhead in benchmarks, and any reduction in performance here will immediately be felt.

	Also, it's specially designed to only allocate the bare minimum it needs to build vnodes, as part
	of this optimization process. It doesn't allocate arguments except as needed to build children, it
	doesn't allocate attributes except to replace them for modifications, among other things.
	*/
	var m = function (selector, attrs) {
		var type = TYPE_ELEMENT;
		var start = 1;
		var children;

		if (typeof selector !== "string") {
			if (typeof selector !== "function") {
				throw new Error("The selector must be either a string or a component.");
			}
			type = selector === m.Fragment ? TYPE_FRAGMENT : TYPE_COMPONENT;
		}


		if (attrs == null || typeof attrs === "object" && typeof attrs.m !== "number" && !Array.isArray(attrs)) {
			start = 2;
			if (arguments.length < 3 && attrs && Array.isArray(attrs.children)) {
				children = attrs.children.slice();
			}
		} else {
			attrs = null;
		}

		if (children == null) {
			if (arguments.length === start + 1 && Array.isArray(arguments[start])) {
				children = arguments[start].slice();
			} else {
				children = [];
				while (start < arguments.length) children.push(arguments[start++]);
			}
		}

		// It may seem expensive to inline elements handling, but it's less expensive than you'd think.
		// DOM nodes are about as commonly constructed as vnodes, but fragments are only constructed
		// from JSX code (and even then, they aren't common).

		if (type === TYPE_ELEMENT) {
			attrs = attrs || {};
			var hasClassName = hasOwn.call(attrs, "className");
			var dynamicClass = hasClassName ? attrs.className : attrs.class;
			var state = selectorCache.get(selector);
			var original = attrs;

			if (state == null) {
				state = /*@__NOINLINE__*/compileSelector(selector);
			}

			if (state.a != null) {
				attrs = {...state.a, ...attrs};
			}

			if (dynamicClass != null || state.c != null) {
				if (attrs !== original) attrs = {...attrs};
				attrs.class = dynamicClass != null
					? state.c != null ? `${state.c} ${dynamicClass}` : dynamicClass
					: state.c;
				if (hasClassName) attrs.className = null;
			}
		}

		if (type === TYPE_COMPONENT) {
			attrs = {children, ...attrs};
			children = null;
		} else {
			for (var i = 0; i < children.length; i++) children[i] = m.normalize(children[i]);
		}

		return Vnode(type, selector, attrs, children)
	};

	m.TYPE_MASK = TYPE_MASK;
	m.TYPE_RETAIN = TYPE_RETAIN;
	m.TYPE_FRAGMENT = TYPE_FRAGMENT;
	m.TYPE_KEYED = TYPE_KEYED;
	m.TYPE_TEXT = TYPE_TEXT;
	m.TYPE_ELEMENT = TYPE_ELEMENT;
	m.TYPE_COMPONENT = TYPE_COMPONENT;
	m.TYPE_LAYOUT = TYPE_LAYOUT;
	m.TYPE_REMOVE = TYPE_REMOVE;
	m.TYPE_SET_CONTEXT = TYPE_SET_CONTEXT;
	m.TYPE_USE = TYPE_USE;
	m.TYPE_INLINE = TYPE_INLINE;

	// Simple and sweet. Also useful for idioms like `onfoo: m.capture` to completely drop events while
	// otherwise ignoring them.
	m.capture = (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		return "skip-redraw"
	};

	m.retain = () => Vnode(TYPE_RETAIN, null, null, null);
	m.inline = (view) => Vnode(TYPE_INLINE, null, checkCallback(view, false, "view"), null);
	m.layout = (callback) => Vnode(TYPE_LAYOUT, null, checkCallback(callback), null);
	m.remove = (callback) => Vnode(TYPE_REMOVE, null, checkCallback(callback), null);

	m.Fragment = (attrs) => attrs.children;

	m.keyed = (values, view) => {
		view = checkCallback(view, true, "view");
		var map = new Map();
		for (var value of values) {
			if (typeof view === "function") value = view(value);
			if (value != null && typeof value !== "boolean") {
				if (!Array.isArray(value) || value.length < 1) {
					throw new TypeError("Returned value must be a `[key, value]` array")
				}
				if (map.has(value[0])) {
					// Coerce to string so symbols don't throw
					throw new TypeError(`Duplicate key detected: ${String(value[0])}`)
				}
				map.set(value[0], m.normalize(value[1]));
			}
		}
		return Vnode(TYPE_KEYED, null, map, null)
	};

	m.set = (entries, ...children) => resolveSpecialFragment(TYPE_SET_CONTEXT, entries, ...children);
	m.use = (deps, ...children) => resolveSpecialFragment(TYPE_USE, [...deps], ...children);

	m.normalize = (node) => {
		if (node == null || typeof node === "boolean") return null
		if (typeof node !== "object") return Vnode(TYPE_TEXT, null, String(node), null)
		if (Array.isArray(node)) return Vnode(TYPE_FRAGMENT, null, null, node.map(m.normalize))
		return node
	};

	var resolveSpecialFragment = (type, attrs, ...children) => {
		var resolved = children.length === 1 && Array.isArray(children[0]) ? [...children[0]] : [...children];
		for (var i = 0; i < resolved.length; i++) resolved[i] = m.normalize(resolved[i]);
		return Vnode(type, null, attrs, resolved)
	};

	var xlinkNs = "http://www.w3.org/1999/xlink";
	var htmlNs = "http://www.w3.org/1999/xhtml";
	var nameSpace = {
		svg: "http://www.w3.org/2000/svg",
		math: "http://www.w3.org/1998/Math/MathML"
	};

	var currentHooks;
	var currentRedraw;
	var currentParent;
	var currentRefNode;
	var currentNamespace;
	var currentDocument;
	var currentContext;
	var currentRemoveOnThrow;

	var insertAfterCurrentRefNode = (child) => {
		if (currentRefNode) {
			currentRefNode.after(currentRefNode = child);
		} else {
			currentParent.prepend(currentRefNode = child);
		}
	};

	//update
	var moveToPosition = (vnode) => {
		var type;
		while ((1 << TYPE_COMPONENT | 1 << TYPE_INLINE) & 1 << (type = vnode.m & TYPE_MASK)) {
			if (!(vnode = vnode.c)) return
		}
		if ((1 << TYPE_FRAGMENT | 1 << TYPE_USE | 1 << TYPE_SET_CONTEXT) & 1 << type) {
			vnode.c.forEach(moveToPosition);
		} else if ((1 << TYPE_TEXT | 1 << TYPE_ELEMENT) & 1 << type) {
			insertAfterCurrentRefNode(vnode.d);
		} else if (type === TYPE_KEYED) {
			vnode.a.forEach(moveToPosition);
		}
	};

	var updateFragment = (old, vnode) => {
		// Patch the common prefix, remove the extra in the old, and create the extra in the new.
		//
		// Can't just take the max of both, because out-of-bounds accesses both disrupts
		// optimizations and is just generally slower.
		//
		// Note: if either `vnode` or `old` is `null`, the common length and its own length are
		// both zero, so it can't actually throw.
		var newLength = vnode != null ? vnode.c.length : 0;
		var oldLength = old != null ? old.c.length : 0;
		var commonLength = oldLength < newLength ? oldLength : newLength;
		try {
			for (var i = 0; i < commonLength; i++) updateNode(old.c[i], vnode.c[i]);
			for (var i = commonLength; i < newLength; i++) updateNode(null, vnode.c[i]);
		} catch (e) {
			commonLength = i;
			for (var i = 0; i < commonLength; i++) updateNode(vnode.c[i], null);
			for (var i = commonLength; i < oldLength; i++) updateNode(old.c[i], null);
			throw e
		}
		for (var i = commonLength; i < oldLength; i++) updateNode(old.c[i], null);
	};

	var updateUse = (old, vnode) => {
		if (
			old != null && old.length !== 0 &&
			vnode != null && vnode.length !== 0 &&
			(
				vnode.a.length !== old.a.length ||
				vnode.a.some((b, i) => !Object.is(b, old.a[i]))
			)
		) {
			updateFragment(old, null);
			old = null;
		}
		updateFragment(old, vnode);
	};

	var updateKeyed = (old, vnode) => {
		// I take a pretty straightforward approach here to keep it simple:
		// 1. Build a map from old map to old vnode.
		// 2. Walk the new vnodes, adding what's missing and patching what's in the old.
		// 3. Remove from the old map the keys in the new vnodes, leaving only the keys that
		//    were removed this run.
		// 4. Remove the remaining nodes in the old map that aren't in the new map. Since the
		//    new keys were already deleted, this is just a simple map iteration.

		// Note: if either `vnode` or `old` is `null`, they won't get here. The default mask is
		// zero, and that causes keyed state to differ and thus a forced linear diff per above.

		var added = 0;
		// It's a value that 1. isn't user-providable and 2. isn't likely to go away in future changes.
		// Works well enough as a sentinel.
		var error = selectorCache;
		try {
			// Iterate the map. I get keys for free that way, and insertion order is guaranteed to be
			// preserved in any spec-conformant engine.
			vnode.a.forEach((n, k) => {
				var p = old != null ? old.a.get(k) : null;
				if (p == null) {
					updateNode(null, n);
				} else {
					var prev = currentRefNode;
					moveToPosition(p);
					currentRefNode = prev;
					updateNode(p, n);
					// Delete from the state set, but only after it's been successfully moved. This
					// avoids needing to specially remove `p` on failure.
					old.a.delete(k);
				}
				added++;
			});
			added = -1;
		} catch (e) {
			error = e;
		}
		if (old != null) removeKeyed(old);
		// Either `added === 0` from the `catch` block or `added === -1` from completing the loop.
		if (error !== selectorCache) {
			for (var n of vnode.a.values()) {
				if (--added) break
				updateNode(n, null);
			}
			throw error
		}
	};

	var updateNode = (old, vnode) => {
		// This is important. Declarative state bindings that rely on dependency tracking, like
		// https://github.com/tc39/proposal-signals and related, memoize their results, but that's the
		// absolute extent of what they necessarily reuse. They don't pool anything. That means all I
		// need to do to support components based on them is just add this neat single line of code
		// here.
		//
		// Code based on streams (see this repo here) will also potentially need this depending on how
		// they do their combinators.
		if (old === vnode) return

		var type;
		if (old == null) {
			if (vnode == null) return
			if (vnode.m < 0) return
			if (vnode.m & FLAG_USED) {
				throw new TypeError("Vnodes must not be reused")
			}
			type = vnode.m & TYPE_MASK;
			vnode.m |= FLAG_USED;
		} else {
			type = old.m & TYPE_MASK;

			if (vnode == null) {
				try {
					if (type !== (TYPE_RETAIN & TYPE_MASK)) removeNodeDispatch[type](old);
				} catch (e) {
					console.error(e);
				}
				return
			}

			if (vnode.m < 0) {
				// If it's a retain node, transmute it into the node it's retaining. Makes it much easier
				// to implement and work with.
				//
				// Note: this key list *must* be complete.
				vnode.m = old.m;
				vnode.t = old.t;
				vnode.s = old.s;
				vnode.a = old.a;
				vnode.c = old.c;
				vnode.d = old.d;
				return
			}

			if (vnode.m & FLAG_USED) {
				throw new TypeError("Vnodes must not be reused")
			}

			if (type === (vnode.m & TYPE_MASK) && vnode.t === old.t) {
				vnode.m = old.m;
			} else {
				updateNode(old, null);
				old = null;
			}
			type = vnode.m & TYPE_MASK;
		}

		try {
			updateNodeDispatch[type](old, vnode);
		} catch (e) {
			updateNode(old, null);
			throw e
		}
	};

	var updateLayout = (_, vnode) => {
		vnode.d = currentParent;
		currentHooks.push(vnode);
	};

	var updateRemove = (_, vnode) => {
		vnode.d = currentParent;
	};

	var emptyObject = {};

	var updateSet = (old, vnode) => {
		var descs = Object.getOwnPropertyDescriptors(vnode.a);
		for (var key of Reflect.ownKeys(descs)) {
			// Drop the descriptor entirely if it's not enumerable. Setting it to an empty object
			// avoids changing its shape, which is useful.
			if (!descs[key].enumerable) descs[key] = emptyObject;
			// Drop the setter if one is present, to keep it read-only.
			else if ("set" in descs[key]) descs[key].set = undefined;
		}
		var prevContext = currentContext;
		currentContext = Object.freeze(Object.create(prevContext, descs));
		updateFragment(old, vnode);
		currentContext = prevContext;
	};

	var updateText = (old, vnode) => {
		if (old == null) {
			insertAfterCurrentRefNode(vnode.d = currentDocument.createTextNode(vnode.a));
		} else {
			if (`${old.a}` !== `${vnode.a}`) old.d.nodeValue = vnode.a;
			vnode.d = currentRefNode = old.d;
		}
	};

	var handleAttributeError = (old, e, force) => {
		if (currentRemoveOnThrow || force) {
			if (old) removeElement(old);
			throw e
		}
		console.error(e);
	};

	var updateElement = (old, vnode) => {
		var prevParent = currentParent;
		var prevRefNode = currentRefNode;
		var prevNamespace = currentNamespace;
		var mask = vnode.m;
		var attrs = vnode.a;
		var element, oldAttrs;

		if (old == null) {
			var entry = selectorCache.get(vnode.t);
			var tag = entry ? entry.t : vnode.t;
			var customTag = tag.includes("-");
			var is = !customTag && attrs && attrs.is;
			var ns = attrs && attrs.xmlns || nameSpace[tag] || prevNamespace;
			var opts = is ? {is} : null;

			element = (
				ns
					? currentDocument.createElementNS(ns, tag, opts)
					: currentDocument.createElement(tag, opts)
			);

			if (ns == null) {
				// Doing it this way since it doesn't seem Terser is smart enough to optimize the `if` with
				// every branch doing `a |= value` for differing `value`s to a ternary. It *is* smart
				// enough to inline the constants, and the following pass optimizes the rest to just
				// integers.
				//
				// Doing a simple constant-returning ternary also makes it easier for engines to emit the
				// right code.
				/* eslint-disable indent */
				vnode.m = mask |= (
					is || customTag
						? FLAG_HTML_ELEMENT | FLAG_CUSTOM_ELEMENT
						: (tag = tag.toUpperCase(), (
							tag === "INPUT" ? FLAG_HTML_ELEMENT | FLAG_INPUT_ELEMENT
							: tag === "SELECT" ? FLAG_HTML_ELEMENT | FLAG_SELECT_ELEMENT
							: tag === "OPTION" ? FLAG_HTML_ELEMENT | FLAG_OPTION_ELEMENT
							: tag === "TEXTAREA" ? FLAG_HTML_ELEMENT | FLAG_TEXTAREA_ELEMENT
							: FLAG_HTML_ELEMENT
						))
				);
				/* eslint-enable indent */

				if (is) element.setAttribute("is", is);
			}

			currentParent = element;
			currentNamespace = ns;
		} else {
			vnode.s = old.s;
			oldAttrs = old.a;
			currentNamespace = (currentParent = element = vnode.d = old.d).namespaceURI;
			if (currentNamespace === htmlNs) currentNamespace = null;
		}

		currentRefNode = null;

		try {
			if (oldAttrs != null && oldAttrs === attrs) {
				throw new Error("Attributes object cannot be reused.")
			}

			if (attrs != null) {
				// The DOM does things to inputs based on the value, so it needs set first.
				// See: https://github.com/MithrilJS/mithril.js/issues/2622
				if (mask & FLAG_INPUT_ELEMENT && attrs.type != null) {
					if (attrs.type === "file") mask |= FLAG_IS_FILE_INPUT;
					element.type = attrs.type;
				}

				for (var key in attrs) {
					setAttr(vnode, element, mask, key, oldAttrs, attrs);
				}
			}

			for (var key in oldAttrs) {
				mask |= FLAG_IS_REMOVE;
				setAttr(vnode, element, mask, key, oldAttrs, attrs);
			}
		} catch (e) {
			return handleAttributeError(old, e, true)
		}

		updateFragment(old, vnode);

		if (mask & FLAG_SELECT_ELEMENT && old == null) {
			try {
				// This does exactly what I want, so I'm reusing it to save some code
				var normalized = getStyleKey(attrs, "value");
				if ("value" in attrs) {
					if (normalized === null) {
						if (element.selectedIndex >= 0) {
							element.value = null;
						}
					} else {
						if (element.selectedIndex < 0 || element.value !== normalized) {
							element.value = normalized;
						}
					}
				}
			} catch (e) {
				handleAttributeError(old, e, false);
			}

			try {
				// This does exactly what I want, so I'm reusing it to save some code
				var normalized = getPropKey(attrs, "selectedIndex");
				if (normalized !== null) {
					element.selectedIndex = normalized;
				}
			} catch (e) {
				handleAttributeError(old, e, false);
			}
		}

		currentParent = prevParent;
		currentRefNode = prevRefNode;
		currentNamespace = prevNamespace;

		// Do this as late as possible to reduce how much work browsers have to do to reduce style
		// recalcs during initial (sub)tree construction. Also will defer `adoptNode` callbacks in
		// custom elements until the last possible point (which will help accelerate some of them).
		if (old == null) {
			insertAfterCurrentRefNode(vnode.d = element);
		}

		currentRefNode = element;
	};

	var updateComponent = (old, vnode) => {
		try {
			var attrs = vnode.a;
			var tree, oldInstance, oldAttrs;
			rendered: {
				if (old != null) {
					tree = old.s;
					oldInstance = old.c;
					oldAttrs = old.a;
				} else if (typeof (tree = (vnode.s = vnode.t).call(currentContext, attrs, oldAttrs)) !== "function") {
					break rendered
				}
				tree = (vnode.s = tree).call(currentContext, attrs, oldAttrs);
			}
			updateNode(oldInstance, vnode.c = m.normalize(tree));
		} catch (e) {
			if (currentRemoveOnThrow) throw e
			console.error(e);
		}
	};

	var updateInline = (old, vnode) => {
		try {
			updateNode(old != null ? old.c : null, vnode.c = m.normalize(vnode.a.call(currentContext, currentContext)));
		} catch (e) {
			if (currentRemoveOnThrow) throw e
			console.error(e);
		}
	};

	var removeFragment = (old) => updateFragment(old, null);

	var removeKeyed = (old) => old.a.forEach((p) => updateNode(p, null));

	var removeNode = (old) => {
		try {
			if (!old.d) return
			old.d.remove();
			old.d = null;
		} catch (e) {
			console.error(e);
		}
	};

	var removeElement = (old) => {
		removeNode(old);
		updateFragment(old, null);
	};

	var removeInstance = (old) => updateNode(old.c, null);

	// Replaces an otherwise necessary `switch`.
	var updateNodeDispatch = [
		updateFragment,
		updateKeyed,
		updateText,
		updateElement,
		updateComponent,
		updateLayout,
		updateRemove,
		updateSet,
		updateUse,
		updateInline,
	];

	var removeNodeDispatch = [
		removeFragment,
		removeKeyed,
		removeNode,
		removeElement,
		removeInstance,
		noop,
		(old) => currentHooks.push(old),
		removeFragment,
		removeFragment,
		removeInstance,
	];

	//attrs

	/* eslint-disable no-unused-vars */
	var ASCII_HYPHEN = 0x2D;
	var ASCII_COLON = 0x3A;
	var ASCII_LOWER_E = 0x65;
	var ASCII_LOWER_F = 0x66;
	var ASCII_LOWER_H = 0x68;
	var ASCII_LOWER_I = 0x69;
	var ASCII_LOWER_K = 0x6B;
	var ASCII_LOWER_L = 0x6C;
	var ASCII_LOWER_M = 0x6D;
	var ASCII_LOWER_N = 0x6E;
	var ASCII_LOWER_O = 0x6F;
	var ASCII_LOWER_P = 0x70;
	var ASCII_LOWER_R = 0x72;
	var ASCII_LOWER_S = 0x73;
	var ASCII_LOWER_T = 0x74;
	var ASCII_LOWER_X = 0x78;
	var ASCII_LOWER_Y = 0x79;
	/* eslint-enable no-unused-vars */

	var getPropKey = (host, key) => {
		if (host != null && hasOwn.call(host, key)) {
			var value = host[key];
			if (value !== false && value != null) return value
		}
		return null
	};

	var getStyleKey = (host, key) => {
		if (host != null && hasOwn.call(host, key)) {
			var value = host[key];
			if (value !== false && value != null) return `${value}`
		}
		return null
	};

	var setStyle = (style, old, value, add) => {
		for (var propName in value) {
			var preferSetter = propName.charCodeAt(0) === ASCII_HYPHEN;
			var propValue = getStyleKey(value, propName);
			if (propValue !== null) {
				var oldValue = getStyleKey(old, propName);
				if (add) {
					if (propValue !== oldValue) {
						if (preferSetter) {
							style[propName] = propValue;
						} else {
							style.setProperty(propName, propValue);
						}
					}
				} else {
					if (oldValue === null) {
						if (preferSetter) {
							style[propName] = "";
						} else {
							style.removeProperty(propName);
						}
					}
				}
			}
		}
	};

	/*
	Edit this with extreme caution, and profile any change you make.

	Not only is this itself a hot spot (it comprises about 3-5% of runtime overhead), but the way it's
	compiled can even sometimes have knock-on performance impacts elsewhere. Per some Turbolizer
	experiments, this will generate around 10-15 KiB of assembly in its final optimized form.

	Some of the optimizations it does:

	- For pairs of attributes, I pack them into two integers so I can compare them in
	  parallel.
	- I reuse the same character loads for `xlink:*` and `on*` to check for other nodes. I do not reuse
	  the last load, as the first 2 characters is usually enough just on its own to know if a special
	  attribute name is matchable.
	- For small attribute names (4 characters or less), the code handles them in full, with no full
	  string comparison.
	- I fuse all the conditions, `hasOwn` and existence checks, and all the add/remove logic into just
	  this, to reduce startup overhead and keep outer loop code size down.
	- I use a lot of labels to reuse as much code as possible, and thus more ICs, to make optimization
	  easier and better-informed.
	- Bit flags are used extensively here to merge as many comparisons as possible. This function is
	  actually the real reason why I'm using bit flags for stuff like `<input type="file">` in the
	  first place - it moves the check to just the create flow where it's only done once.
	*/
	var setAttr = (vnode, element, mask, key, old, attrs) => {
		try {
			var newValue = getPropKey(attrs, key);
			var oldValue = getPropKey(old, key);

			if (mask & FLAG_IS_REMOVE && newValue !== null) return

			forceSetAttribute: {
				forceTryProperty: {
					skipValueDiff: {
						if (key.length > 1) {
							var pair1 = key.charCodeAt(0) | key.charCodeAt(1) << 16;

							if (key.length === 2 && pair1 === (ASCII_LOWER_I | ASCII_LOWER_S << 16)) {
								return
							} else if (pair1 === (ASCII_LOWER_O | ASCII_LOWER_N << 16)) {
								if (newValue === oldValue) return
								// Update the event
								if (typeof newValue === "function") {
									if (typeof oldValue !== "function") {
										if (vnode.s == null) vnode.s = new EventDict();
										element.addEventListener(key.slice(2), vnode.s);
									}
									// Save this, so the current redraw is correctly tracked.
									vnode.s._ = currentRedraw;
									vnode.s.set(key, newValue);
								} else if (typeof oldValue === "function") {
									element.removeEventListener(key.slice(2), vnode.s);
									vnode.s.delete(key);
								}
								return
							} else if (key.length > 3) {
								var pair2 = key.charCodeAt(2) | key.charCodeAt(3) << 16;
								if (
									key.length > 6 &&
									pair1 === (ASCII_LOWER_X | ASCII_LOWER_L << 16) &&
									pair2 === (ASCII_LOWER_I | ASCII_LOWER_N << 16) &&
									(key.charCodeAt(4) | key.charCodeAt(5) << 16) === (ASCII_LOWER_K | ASCII_COLON << 16)
								) {
									key = key.slice(6);
									if (newValue !== null) {
										element.setAttributeNS(xlinkNs, key, newValue);
									} else {
										element.removeAttributeNS(xlinkNs, key);
									}
									return
								} else if (key.length === 4) {
									if (
										pair1 === (ASCII_LOWER_T | ASCII_LOWER_Y << 16) &&
										pair2 === (ASCII_LOWER_P | ASCII_LOWER_E << 16)
									) {
										if (!(mask & FLAG_INPUT_ELEMENT)) break skipValueDiff
										if (newValue === null) break forceSetAttribute
										break forceTryProperty
									} else if (
										// Try to avoid a few browser bugs on normal elements.
										pair1 === (ASCII_LOWER_H | ASCII_LOWER_R << 16) && pair2 === (ASCII_LOWER_E | ASCII_LOWER_F << 16) ||
										pair1 === (ASCII_LOWER_L | ASCII_LOWER_I << 16) && pair2 === (ASCII_LOWER_S | ASCII_LOWER_T << 16) ||
										pair1 === (ASCII_LOWER_F | ASCII_LOWER_O << 16) && pair2 === (ASCII_LOWER_R | ASCII_LOWER_M << 16)
									) {
										// If it's a custom element, just keep it. Otherwise, force the attribute
										// to be set.
										if (!(mask & FLAG_CUSTOM_ELEMENT)) {
											break forceSetAttribute
										}
									}
								} else if (key.length > 4) {
									switch (key) {
										case "children":
											return

										case "class":
										case "className":
										case "title":
											if (newValue === null) break forceSetAttribute
											break forceTryProperty

										case "value":
											if (
												// Filter out non-HTML keys and custom elements
												(mask & (FLAG_HTML_ELEMENT | FLAG_CUSTOM_ELEMENT)) !== FLAG_HTML_ELEMENT ||
												!(key in element)
											) {
												break
											}

											if (newValue === null) {
												if (mask & (FLAG_OPTION_ELEMENT | FLAG_SELECT_ELEMENT)) {
													break forceSetAttribute
												} else {
													break forceTryProperty
												}
											}

											if (!(mask & (FLAG_INPUT_ELEMENT | FLAG_TEXTAREA_ELEMENT | FLAG_SELECT_ELEMENT | FLAG_OPTION_ELEMENT))) {
												break
											}

											// It's always stringified, so it's okay to always coerce
											if (element.value === (newValue = `${newValue}`)) {
												// Setting `<input type="file" value="...">` to the same value causes an
												// error to be generated if it's non-empty
												if (mask & FLAG_IS_FILE_INPUT) return
												// Setting `<input value="...">` to the same value by typing on focused
												// element moves cursor to end in Chrome
												if (mask & (FLAG_INPUT_ELEMENT | FLAG_TEXTAREA_ELEMENT)) {
													if (element === currentDocument.activeElement) return
												} else {
													if (oldValue != null && oldValue !== false) return
												}
											}

											if (mask & FLAG_IS_FILE_INPUT) {
												//setting input[type=file][value] to different value is an error if it's non-empty
												// Not ideal, but it at least works around the most common source of uncaught exceptions for now.
												if (newValue !== "") {
													console.error("File input `value` attributes must either mirror the current value or be set to the empty string (to reset).");
													return
												}
											}

											break forceTryProperty

										case "style":
											if (oldValue === newValue) {
												// Styles are equivalent, do nothing.
											} else if (newValue === null) {
												// New style is missing, just clear it.
												element.style = "";
											} else if (typeof newValue !== "object") {
												// New style is a string, let engine deal with patching.
												element.style = newValue;
											} else if (oldValue === null || typeof oldValue !== "object") {
												// `old` is missing or a string, `style` is an object.
												element.style = "";
												// Add new style properties
												setStyle(element.style, null, newValue, true);
											} else {
												// Both old & new are (different) objects, or `old` is missing.
												// Update style properties that have changed, or add new style properties
												setStyle(element.style, oldValue, newValue, true);
												// Remove style properties that no longer exist
												setStyle(element.style, newValue, oldValue, false);
											}
											return

										case "selected":
											var active = currentDocument.activeElement;
											if (
												element === active ||
												mask & FLAG_OPTION_ELEMENT && element.parentNode === active
											) {
												break
											}
											// falls through

										case "checked":
										case "selectedIndex":
											break skipValueDiff

										// Try to avoid a few browser bugs on normal elements.
										case "width":
										case "height":
											// If it's a custom element, just keep it. Otherwise, force the attribute
											// to be set.
											if (!(mask & FLAG_CUSTOM_ELEMENT)) {
												break forceSetAttribute
											}
									}
								}
							}
						}

						if (newValue !== null && typeof newValue !== "object" && oldValue === newValue) return
					}

					// Filter out namespaced keys
					if (!(mask & FLAG_HTML_ELEMENT)) {
						break forceSetAttribute
					}
				}

				// Filter out namespaced keys
				// Defer the property check until *after* we check everything.
				if (key in element) {
					element[key] = newValue;
					return
				}
			}

			if (newValue === null) {
				if (oldValue !== null) element.removeAttribute(key);
			} else {
				element.setAttribute(key, newValue === true ? "" : newValue);
			}
		} catch (e) {
			handleAttributeError(old, e, false);
		}
	};

	// Here's an explanation of how this works:
	// 1. The event names are always (by design) prefixed by `on`.
	// 2. The EventListener interface accepts either a function or an object with a `handleEvent` method.
	// 3. The object inherits from `Map`, to avoid hitting global setters.
	// 4. The event name is remapped to the handler before calling it.
	// 5. In function-based event handlers, `ev.currentTarget === this`. We replicate that below.
	// 6. In function-based event handlers, `return false` prevents the default action and stops event
	//    propagation. Instead of that, we hijack the return value, so we can have it auto-redraw if
	//    the user returns `"skip-redraw"` or a promise that resolves to it.
	class EventDict extends Map {
		async handleEvent(ev) {
			invokeRedrawable(this._, this.get(`on${ev.type}`), ev.currentTarget, ev);
		}
	}

	var currentlyRendering = [];

	m.render = (dom, vnode, {redraw, removeOnThrow} = {}) => {
		if (!dom) {
			throw new TypeError("DOM element being rendered to does not exist.")
		}

		checkCallback(redraw, true, "redraw");

		for (var root of currentlyRendering) {
			if (dom.contains(root)) {
				throw new TypeError("Node is currently being rendered to and thus is locked.")
			}
		}

		var active = dom.ownerDocument.activeElement;
		var namespace = dom.namespaceURI;

		var prevHooks = currentHooks;
		var prevRedraw = currentRedraw;
		var prevParent = currentParent;
		var prevRefNode = currentRefNode;
		var prevNamespace = currentNamespace;
		var prevDocument = currentDocument;
		var prevContext = currentContext;
		var prevRemoveOnThrow = currentRemoveOnThrow;
		var hooks = currentHooks = [];

		try {
			currentlyRendering.push(currentParent = dom);
			currentRedraw = typeof redraw === "function" ? redraw : null;
			currentRefNode = null;
			currentNamespace = namespace === htmlNs ? null : namespace;
			currentDocument = dom.ownerDocument;
			currentContext = {redraw};
			// eslint-disable-next-line no-implicit-coercion
			currentRemoveOnThrow = !!removeOnThrow;

			// First time rendering into a node clears it out
			if (dom.vnodes == null) dom.textContent = "";
			updateNode(dom.vnodes, vnode = m.normalize(vnode));
			dom.vnodes = vnode;
			// `document.activeElement` can return null: https://html.spec.whatwg.org/multipage/interaction.html#dom-document-activeelement
			if (active != null && currentDocument.activeElement !== active && typeof active.focus === "function") {
				active.focus();
			}
			for (var {a, d} of hooks) {
				try {
					a(d);
				} catch (e) {
					console.error(e);
				}
			}
		} finally {
			currentRedraw = prevRedraw;
			currentHooks = prevHooks;
			currentParent = prevParent;
			currentRefNode = prevRefNode;
			currentNamespace = prevNamespace;
			currentDocument = prevDocument;
			currentContext = prevContext;
			currentRemoveOnThrow = prevRemoveOnThrow;
			currentlyRendering.pop();
		}
	};

	m.mount = (root, view) => {
		if (!root) throw new TypeError("Root must be an element")

		if (typeof view !== "function") {
			throw new TypeError("View must be a function")
		}

		var window = root.ownerDocument.defaultView;
		var id = 0;
		var unschedule = () => {
			if (id) {
				window.cancelAnimationFrame(id);
				id = 0;
			}
		};
		var redraw = () => { if (!id) id = window.requestAnimationFrame(redraw.sync); };
		// Cheating with context access for a minor bundle size win.
		var Mount = (_, old) => [m.remove(unschedule), view.call(currentContext, !old)];
		redraw.sync = () => {
			unschedule();
			m.render(root, m(Mount), {redraw});
		};

		m.render(root, null);
		redraw.sync();

		return redraw
	};

	/* global performance, setTimeout, clearTimeout */


	var validateDelay = (delay) => {
		if (!Number.isFinite(delay) || delay <= 0) {
			throw new RangeError("Timer delay must be finite and positive")
		}
	};

	var rateLimiterImpl = (delay = 500, isThrottler) => {
		validateDelay(delay);

		var closed = false;
		var start = 0;
		var timer = 0;
		var resolveNext = noop;

		var callback = () => {
			timer = undefined;
			resolveNext(false);
			resolveNext = noop;
		};

		var rateLimiter = async (ignoreLeading) => {
			if (closed) {
				return true
			}

			resolveNext(true);
			resolveNext = noop;

			if (timer) {
				if (isThrottler) {
					return new Promise((resolve) => resolveNext = resolve)
				}

				clearTimeout(timer);
				ignoreLeading = true;
			}

			start = performance.now();
			timer = setTimeout(callback, delay);

			if (!ignoreLeading) {
				return
			}

			return new Promise((resolve) => resolveNext = resolve)
		};

		rateLimiter.update = (newDelay) => {
			validateDelay(newDelay);
			delay = newDelay;

			if (closed) return
			if (timer) {
				clearTimeout(timer);
				timer = setTimeout(callback, (start - performance.now()) + delay);
			}
		};

		rateLimiter.dispose = () => {
			if (closed) return
			closed = true;
			clearTimeout(timer);
			resolveNext(true);
			resolveNext = noop;
		};

		return rateLimiter
	};

	/**
	 * A general-purpose bi-edge throttler, with a dynamically configurable limit. It's much better
	 * than your typical `throttle(f, ms)` because it lets you easily separate the trigger and reaction
	 * using a single shared, encapsulated state object. That same separation is also used to make the
	 * rate limit dynamically reconfigurable on hit.
	 *
	 * Create as `throttled = m.throttler(ms)` and do `if (await throttled()) return` to rate-limit
	 * the code that follows. The result is one of three values, to allow you to identify edges:
	 *
	 * - Leading edge: `undefined`
	 * - Trailing edge: `false`, returned only if a second call was made
	 * - No edge: `true`
	 *
	 * Call `throttled.update(ms)` to update the interval. This not only impacts future delays, but also any current one.
	 *
	 * To dispose, like on component removal, call `throttled.dispose()`.
	 *
	 * If you don't sepecify a delay, it defaults to 500ms on creation, which works well enough for
	 * most needs. There is no default for `throttled.update(...)` - you must specify one explicitly.
	 *
	 * Example usage:
	 *
	 * ```js
	 * const throttled = m.throttler()
	 * let results, error
	 * return function () {
	 *     return [
	 *         m.remove(throttled.dispose),
	 *         m("input[type=search]", {
	 *             oninput: async (ev) => {
	 *                 // Skip redraw if rate limited - it's pointless
	 *                 if (await throttled()) return false
	 *                 error = results = null
	 *                 this.redraw()
	 *                 try {
	 *                     const response = await fetch(m.p("/search", {q: ev.target.value}))
	 *                     if (response.ok) {
	 *                         results = await response.json()
	 *                     } else {
	 *                         error = await response.text()
	 *                     }
	 *                 } catch (e) {
	 *                     error = e.message
	 *                 }
	 *             },
	 *         }),
	 *         results.map((result) => m(SearchResult, {result})),
	 *         !error || m(ErrorDisplay, {error})),
	 *     ]
	 * }
	 * ```
	 *
	 * Important note: due to the way this is implemented in basically all runtimes, the throttler's
	 * clock might not tick during sleep, so if you do `await throttled()` and immediately sleep in a
	 * low-power state for 5 minutes, you might have to wait another 10 minutes after resuming to a
	 * high-power state.
	 */
	var throttler = (delay) => rateLimiterImpl(delay, 1);

	/**
	 * A general-purpose bi-edge debouncer, with a dynamically configurable limit. It's much better
	 * than your typical `debounce(f, ms)` because it lets you easily separate the trigger and reaction
	 * using a single shared, encapsulated state object. That same separation is also used to make the
	 * rate limit dynamically reconfigurable on hit.
	 *
	 * Create as `debounced = m.debouncer(ms)` and do `if (await debounced()) return` to rate-limit
	 * the code that follows. The result is one of three values, to allow you to identify edges:
	 *
	 * - Leading edge: `undefined`
	 * - Trailing edge: `false`, returned only if a second call was made
	 * - No edge: `true`
	 *
	 * Call `debounced.update(ms)` to update the interval. This not only impacts future delays, but also any current one.
	 *
	 * To dispose, like on component removal, call `debounced.dispose()`.
	 *
	 * If you don't sepecify a delay, it defaults to 500ms on creation, which works well enough for
	 * most needs. There is no default for `debounced.update(...)` - you must specify one explicitly.
	 *
	 * Example usage:
	 *
	 * ```js
	 * const debounced = m.debouncer()
	 * let results, error
	 * return (attrs) => [
	 *     m.remove(debounced.dispose),
	 *     m("input[type=text].value", {
	 *         async oninput(ev) {
	 *             // Skip redraw if rate limited - it's pointless
	 *             if ((await debounced()) !== false) return false
	 *             try {
	 *                 const response = await fetch(m.p("/save/:id", {id: attrs.id}), {
	 *                     body: JSON.stringify({value: ev.target.value}),
	 *                 })
	 *                 if (!response.ok) {
	 *                     error = await response.text()
	 *                 }
	 *             } catch (e) {
	 *                 error = e.message
	 *             }
	 *         },
	 *     }),
	 *     results.map((result) => m(SearchResult, {result})),
	 *     !error || m(ErrorDisplay, {error})),
	 * ]
	 * ```
	 *
	 * Important note: due to the way this is implemented in basically all runtimes, the debouncer's
	 * clock might not tick during sleep, so if you do `await debounced()` and immediately sleep in a
	 * low-power state for 5 minutes, you might have to wait another 10 minutes after resuming to a
	 * high-power state.
	 */
	var debouncer = (delay) => rateLimiterImpl(delay, 0);

	/* global window: false */

	var Route = function ({p: prefix}) {
		var href = this.href;
		var mustReplace, redraw, currentParsedHref;
		var currentRoute;

		var updateRouteWithHref = () => {
			var url = new URL(href);
			var urlPath = url.pathname + url.search + url.hash;
			var decodedPrefix = prefix;
			var index = urlPath.indexOf(decodedPrefix);
			if (index < 0) index = urlPath.indexOf(decodedPrefix = encodeURI(decodedPrefix));
			if (index >= 0) urlPath = urlPath.slice(index + decodedPrefix.length);
			if (urlPath[0] !== "/") urlPath = `/${urlPath}`;

			var parsedUrl = new URL(urlPath, href);
			var path = decodeURI(parsedUrl.pathname);
			mustReplace = false;
			currentRoute = {
				prefix,
				path,
				params: parsedUrl.searchParams,
				current: path + parsedUrl.search + parsedUrl.hash,
				set,
				match,
			};
			return currentParsedHref = parsedUrl.href
		};

		var updateRoute = () => {
			if (href === window.location.href) return
			href = window.location.href;
			if (currentParsedHref !== updateRouteWithHref()) redraw();
		};

		var set = (path, {replace, state} = {}) => {
			if (mustReplace) replace = true;
			mustReplace = true;
			queueMicrotask(updateRoute);
			redraw();
			if (typeof window === "object") {
				window.history[replace ? "replaceState" : "pushState"](state, "", prefix + path);
			}
		};

		var match = (path) => m.match(currentRoute, path);

		if (!href) {
			if (typeof window !== "object") {
				throw new TypeError("Outside the DOM, `href` must be set")
			}
			href = window.location.href;
			window.addEventListener("popstate", updateRoute);
		} else if (typeof href !== "string") {
			throw new TypeError("The initial route href must be a string if given")
		}

		updateRouteWithHref();

		return function ({v: view}) {
			redraw = checkCallback(this.redraw, false, "context.redraw");

			return [
				m.remove(() => window.removeEventListener("popstate", updateRoute)),
				m.set({route: currentRoute}, m.inline(view)),
			]
		}
	};

	var route = (prefix, view) => {
		if (typeof prefix !== "string") {
			throw new TypeError("The route prefix must be a string")
		}

		return m(Route, {v: checkCallback(view, false, "view"), p: prefix})
	};

	// Let's provide a *right* way to manage a route link, rather than letting people screw up
	// accessibility on accident.
	//
	// Note: this does *not* support disabling. Instead, consider more accessible alternatives like not
	// showing the link in the first place. If you absolutely have to disable the link, disable it by
	// removing this component (like via `m("div", {disabled}, !disabled && m(Link))`). There's
	// friction here for a reason.
	var Link = () => {
		var href, opts, setRoute;
		var listener = (ev) => {
			// Adapted from React Router's implementation:
			// https://github.com/ReactTraining/react-router/blob/520a0acd48ae1b066eb0b07d6d4d1790a1d02482/packages/react-router-dom/modules/Link.js
			//
			// Try to be flexible and intuitive in how we handle links.
			// Fun fact: links aren't as obvious to get right as you
			// would expect. There's a lot more valid ways to click a
			// link than this, and one might want to not simply click a
			// link, but right click or command-click it to copy the
			// link target, etc. Nope, this isn't just for blind people.
			if (
				// Skip if `onclick` prevented default
				!ev.defaultPrevented &&
				// Ignore everything but left clicks
				(ev.button === 0 || ev.which === 0 || ev.which === 1) &&
				// Let the browser handle `target=_blank`, etc.
				(!ev.currentTarget.target || ev.currentTarget.target === "_self") &&
				// No modifier keys
				!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey
			) {
				setRoute(href, opts);
				// Capture the event, and don't double-call `redraw`.
				return m.capture(ev)
			}
		};

		return function (attrs, old) {
			setRoute = this.route.set;
			href = attrs.h;
			opts = attrs.o;
			return [
				m.layout((dom) => {
					dom.href = this.route.prefix + href;
					if (!old) dom.addEventListener("click", listener);
				}),
				m.remove((dom) => {
					dom.removeEventListener("click", listener);
				}),
			]
		}
	};

	var link = (href, opts) => m(Link, {h: `${href}`, o: opts});

	/*
	Caution: `m.p` and the failure path of `m.match` are both perf-sensitive. More so than you might
	think. And unfortunately, string indexing is incredibly slow.

	Suppose we're in a large CRUD app with 20 resources and 10 pages for each resource, for a total of
	200 routes. And further, suppose we're on a complicated management page (like a domain management
	page) with a grid of 50 rows and 8 routed icon links each. Each link has its URL constructed via
	`m.p(...)`, for a total of 400 calls. (This is high, but still realistic. At the time of writing,
	Namesilo's UI for selecting domains and performing batch operations on them is designed as a table
	with about that many icon links and up to 100 domains per page.)

	To meet 60 FPS, we generally have to have the whole page rendered in under 10ms for the browser to
	not skip frames. To give the user some buffer for view inefficiency, let's aim for 2ms of overhead
	for all the `m.match` and `m.p` calls. From some local benchmarking, the failure path of `m.match`
	requires about 1us/op, so 200 routes would come out to about 0.2ms. (The success path is well under
	0.1ms, so its overhead is negligible.) That leaves us about 1.8ms for 400 calls to `m.p(...)`. Do
	the math, and that comes out to a whopping 4.5 us/call for us to meet our deadline.

	I've tried the following for `m.p`, and most of them ended up being too slow. Times are for calls
	with two string interpolation parameters (the slow path), measured on an older laptop. The laptop
	experiences a roughly 30-60% perf boost when charging over when running from battery. The lower end
	is while charging, the higher end is while on battery.

	- A direct port of v2's `m.buildPathname`: 15-25 us
		- This provides headroom for up to about 70 calls per frame.
	- Replace its inner `template.replace` with a `re.exec(template)` loop: 12-18 microseconds
		- This provides headroom for up to about 100 calls per frame.
	- Switch from using match strings to computing positions from `exec.index`: 6.5-12 microseconds
		- This provides headroom for up to about 150 calls per frame.
	- Switch from using match strings to computing positions from `exec.index`: 6.5-12 microseconds
		- This provides headroom for up to about 150 calls per frame.
	- Iterate string directly: 2-3.5 microseconds
		- This provides headroom for up to about 500 calls per frame.

	I've tried optimizing it further, but I'm running into the limits of string performance at this
	point. And the computing positions from `exec.index` is about the fastest I could get any
	regexp-based solution to go.

	Also, I tried at first restricting parameters to JS identifiers (like `m.match` parameters are, as
	I use named groups to generate the properties), but that, just on the regexp side, cut performance
	in more than half. The `exec.match` form, the ideal one for regexp-based solutions, slowed down
	from 12 microseconds to about 35-40 microseconds. And that would reduce headroom down to only about
	45-50 calls per frame. This rate is simply too slow to even be viable for some smaller apps.
	*/


	var toString = {}.toString;

	var invalidMatchTemplate = /\/\/|[:*][^$_\p{IDS}]|[:*].[$\p{IDC}]*[:*]|\*.*?[^$\p{IDC}]|:([$_\p{IDS}][$\p{IDC}]*)[^$\p{IDC}].*?[:*]\1(?![$\p{IDC}])/u;
	// I escape literal text so people can use things like `:file.:ext` or `:lang-:locale` in routes.
	// This is all merged into one pass so I don't also accidentally escape `-` and make it harder to
	// detect it to ban it from template parameters.
	var matcherCompile = /([:*])([$_\p{IDS}][$\p{IDC}]*)|\\\\|\\?([$^*+.()|[\]{}])|\\(.)/ug;

	var serializeQueryValue = (pq, result, prefix, value) => {
		var proto;

		if (value != null && value !== false) {
			if (Array.isArray(value)) {
				for (var i of value) {
					result = serializeQueryValue(pq, result, `${prefix}[]`, i);
				}
			} else if (
				typeof value === "object" &&
				((proto = Object.getPrototypeOf(value)) == null || proto === Object.prototype || toString.call(value) === "[object Object]")
			) {
				for (var k in value) {
					if (hasOwn.call(value, k)) {
						result = serializeQueryValue(pq, result, `${prefix}[${k}]`, value[k]);
					}
				}
			} else {
				var sep = pq.s;
				pq.s = "&";
				result += sep + encodeURIComponent(prefix) + (value === true ? "" : `=${
				typeof value === "number" || typeof value === "bigint"
					? value
					: encodeURIComponent(value)
			}`);
			}
		}

		return result
	};

	var serializeQueryParams = (sep, value, exclude, params) => {
		var pq = {s: sep};
		for (var key in params) {
			if (hasOwn.call(params, key) && !exclude.includes(key)) {
				value = serializeQueryValue(pq, value, key, params[key]);
			}
		}
		return value
	};

	var query = (params) => serializeQueryParams("", "", [], params);

	var QUERY = 0;
	var ESCAPE = 1;
	var CHAR = 2;
	// Structure:
	// Bit 0: is raw
	// Bit 1: is next
	// Bit 2: always set
	var VAR_START = 4;
	// var RAW_VAR_START = 5
	var VAR_NEXT = 6;
	// var RAW_VAR_NEXT = 7
	var STATE_IS_RAW = 1;
	var STATE_IS_NEXT = 2;


	// Returns `path` from `template` + `params`
	/**
	 * @param {string} template
	 * @param {undefined | null | Record<string, any>} params
	 */
	var p = (template, params) => {
		// This carefully only iterates the template once.
		var prev = 0;
		var start = 0;
		var state = CHAR;
		// An array is fine. It's almost never large enough for the overhead of hashing to pay off.
		var inTemplate = [];
		// Used for later.
		var hash = "";
		var queryIndex = -1;
		var hashIndex = -1;
		var result = "";
		var sep = "?";

		var NOT_VAR_NEXT = VAR_NEXT - 1;

		// Using `for ... of` so the engine can do bounds check elimination more easily.
		for (var i = 0;; i++) {
			var ch = template.charAt(i);

			if (
				state > NOT_VAR_NEXT &&
				(ch === "" || ch === "#" || ch === "?" || ch === "\\" || ch === "/" || ch === "." || ch === "-")
			) {
				var segment = template.slice(start + 1, i);

				// If no such parameter exists, don't interpolate it.
				if (params != null && params[segment] != null) {
					inTemplate.push(segment);
					segment = `${params[segment]}`;

					// Escape normal parameters, but not variadic ones.
					// eslint-disable-next-line no-bitwise
					if (state & STATE_IS_RAW) {
						var newHashIndex = segment.indexOf("#");
						var newQueryIndex = (newHashIndex < 0 ? segment : segment.slice(0, newHashIndex)).indexOf("?");
						if (newQueryIndex >= 0) {
							sep = "&";
							queryIndex = result.length + (prev - start) + newQueryIndex;
						}
						if (newHashIndex >= 0) {
							hashIndex = result.length + (prev - start) + newHashIndex;
						}
					} else {
						segment = encodeURIComponent(segment);
					}

					// Drop the preceding `:`/`*`/`\` character from the appended segment
					if (prev !== start) {
						result += template.slice(prev, start);
					}

					result += segment;

					// Start from the next end
					prev = i;
				}
			}

			if (ch === "#") {
				if (hashIndex < 0) hashIndex = i;
			} else if (ch !== "") {
				if (state === QUERY) ; else if (ch === "?") {
					// The query start cannot be escaped. It's a proper URL delimiter.
					if (queryIndex < 0) {
						queryIndex = i;
						sep = "&";
					} else {
						// Inject an `&` in place of a `?`. Note that `sep === "&"`
						if (prev !== i) result += template.slice(prev, i);
						result += "&";
						prev = i + 1;
					}
					state = QUERY;
				} else if (state === ESCAPE) {
					// Drop the preceding `\` character from the appended segment
					if (prev !== start) {
						result += template.slice(prev, start);
					}

					state = CHAR;
					start = prev = i;
				} else if (ch === "\\") {
					start = i;
					state = ESCAPE;
				} else if (ch === ":" || ch === "*") {
					if (state > CHAR) {
						throw new SyntaxError("Template parameter names must be separated by either a '/', '-', or '.'.")
					}
					// eslint-disable-next-line no-bitwise
					state = VAR_START | (ch === "*");
					start = i;
				} else if (ch === "/" || ch === "." || ch === "-") {
					state = CHAR;
				} else if (state > CHAR) {
					// eslint-disable-next-line no-bitwise
					state |= STATE_IS_NEXT;
				}

				continue
			}

			if (prev === 0 && params == null) {
				return template
			}

			if (prev < template.length) {
				result += template.slice(prev);
			}

			if (hashIndex >= 0) {
				hash = result.slice(hashIndex);
				result = result.slice(0, hashIndex);
			}

			return serializeQueryParams(sep, result, inTemplate, params) + hash
		}
	};

	/** @typedef {RegExp & {r: number, p: URLSearchParams}} Matcher */

	/** @type {Map<string, Matcher>} */
	var cache = new Map();

	/** @param {string} pattern @returns {Matcher} */
	var compile = (pattern) => {
		if (invalidMatchTemplate.test(pattern)) {
			throw new SyntaxError("Invalid pattern")
		}

		var queryIndex = pattern.indexOf("?");
		var hashIndex = pattern.indexOf("#");
		var index = queryIndex < hashIndex ? queryIndex : hashIndex;
		var rest;
		var re = new RegExp(`^${pattern.slice(0, index < 0 ? undefined : index).replace(
		matcherCompile,
		(_, p, name, esc1, esc2) => {
			if (p === "*") {
				rest = name;
				return `(?<${name}>.*)`
			} else if (p === ":") {
				return `(?<${name}>[^/]+)`
			} else {
				return esc2 || `\\${esc1 || "\\"}`
			}
		}
	)}$`, "u");
		cache.set(pattern, re);
		re.r = rest;
		re.p = new URLSearchParams(index < 0 ? "" : pattern.slice(index, hashIndex < 0 ? undefined : hashIndex));
		return re
	};

	/** @param {{path: string, params: URLSearchParams}} route */
	var match = ({path, params}, pattern) => {
		var re = cache.get(pattern);
		if (!re) {
			re = /*@__NOINLINE__*/compile(pattern);
		}

		var exec = re.exec(path);
		var restIndex = re.r;
		if (!exec) return

		for (var [k, v] of re.p) {
			if (params.get(k) !== v) return
		}

		// Taking advantage of guaranteed insertion order and group iteration order here to reduce the
		// condition to a simple numeric comparison.
		for (var k in exec.groups) {
			if (restIndex--) {
				exec.groups[k] = decodeURIComponent(exec.groups[k]);
			}
		}

		return {...exec.groups}
	};

	/*
	Here's the intent.
	- Usage in model:
		- List
		- Get
		- Track
		- Delete
		- Replace (equivalent to delete + track)
	- Usage in view:
		- Iterate live handles
		- Release aborted live handles that no longer needed

	Models can do basic CRUD operations on the collection.
	- They can list what's currently there.
	- They can get a current value.
	- They can set the current value.
	- They can delete the current value.
	- They can replace the current value, deleting a value that's already there.

	In the view, they use handles to abstract over the concept of a key. Duplicates are theoretically
	possible, so they should use the handle itself as the key for `m.keyed(...)`. It might look
	something like this:

	```js
	return m.keyed(t.live(), (handle) => (
		[handle.key, m(Entry, {
			name: handle.key,
			value: handle.value,
			removed: handle.signal.aborted,
			onremovaltransitionended: () => handle.release(),
		})]
	))
	```

	There used to be an in-renderer way to manage this transparently, but there's a couple big reasons
	why that was removed in favor of this:

	1. It's very complicated to get right. Like, the majority of the removal code was related to it. In
	   fact, this module is considerably smaller than the code that'd have to go into the renderer to
	   support it, as this isn't nearly as perf-sensitive as that.
	2. When you need to remove something asynchronously, there's multiple ways you may want to manage
	   transitions. You might want to stagger them. You might want to do them all at once. You might
	   want to clear some state and not other state. You might want to preserve some elements of a
	   sibling's state. Embedding it in the renderer would force an opinion on you, and in order to
	   work around it, you'd have to do something like this anyways.

	As for the difference between `m.trackedList()` and `m.tracked()`, the first is for tracking lists
	(and is explained above), and `m.tracked()` is for single values (but uses `m.trackedList()`
	internally to avoid a ton of code duplication).
	*/


	/**
	 * @template K, V
	 * @typedef TrackedHandle
	 *
	 * @property {K} key
	 * @property {V} value
	 * @property {AbortSignal} signal
	 * @property {() => void} release
	 * @property {() => void} remove
	 */

	/**
	 * @template K, V
	 * @typedef Tracked
	 *
	 * @property {() => Array<TrackedHandle<K, V>>} live
	 * @property {() => Array<[K, V]>} list
	 * @property {(key: K) => boolean} has
	 * @property {(key: K) => undefined | V} get
	 * @property {(key: K, value: V) => void} set
	 * @property {(key: K, value: V) => void} replace
	 * @property {(key: K) => boolean} delete
	 */

	var trackedState = (redraw) => {
		checkCallback(redraw, false, "redraw");
		/** @type {Map<K, AbortController & TrackedHandle<K, V>>} */
		var state = new Map();
		var removed = new WeakSet();
		/** @type {Set<TrackedHandle<K, V>>} */ var live = new Set();

		/** @param {null | AbortController & TrackedHandle<K, V>} prev */
		var abort = (prev) => {
			try {
				if (prev) {
					if (removed.has(prev)) {
						live.delete(prev);
					} else {
						prev.abort();
					}
				}
			} catch (e) {
				console.error(e);
			}
		};

		/** @param {K} k */
		var remove = (k, r) => {
			var prev = state.get(k);
			var result = state.delete(k);
			abort(prev);
			if (r) redraw();
			return result
		};

		/**
		 * @param {K} k
		 * @param {V} v
		 * @param {number} bits
		 * Bit 1 forcibly releases the old handle, and bit 2 causes an update notification to be sent
		 * (something that's unwanted during initialization).
		 */
		var setHandle = (k, v, bits) => {
			var prev = state.get(k);
			// Note: it extending `AbortController` is an implementation detail. It exposing a `signal`
			// property is *not*.
			var handle = /** @type {AbortController & TrackedHandle<K, V>} */ (new AbortController());
			handle.key = k;
			handle.value = v;
			handle.release = (ev) => {
				if (ev) m.capture(ev);
				if (!handle) return
				if (state.get(handle.key) === handle) {
					removed.add(handle);
					handle = null;
				} else if (live.delete(handle)) {
					redraw();
				}
			};
			handle.remove = (ev) => {
				if (ev) m.capture(ev);
				remove(handle.key, 0);
			};
			state.set(k, handle);
			live.add(handle);
			// eslint-disable-next-line no-bitwise
			if (bits & 1) live.delete(prev);
			abort(prev);
			// eslint-disable-next-line no-bitwise
			if (bits & 2) redraw();
		};

		return {s: state, l: live, h: setHandle, r: remove}
	};

	/**
	 * @template K, V
	 * @param {Iterable<[K, V]>} [initial]
	 * @param {() => void} redraw
	 * @returns {TrackedList<K, V>}
	 */
	var trackedList = (redraw, initial) => {
		var {s: state, l: live, h: setHandle, r: remove} = trackedState(redraw);

		for (var [k, v] of initial || []) setHandle(k, v, 1);

		return {
			live: () => [...live],
			list: () => Array.from(state.values(), (h) => [h.key, h.value]),
			has: (k) => state.has(k),
			get: (k) => (k = state.get(k)) && k.value,
			set: (k, v) => setHandle(k, v, 3),
			replace: (k, v) => setHandle(k, v, 2),
			delete: (k) => remove(k, 1),
			forget: (k) => (k = state.get(k)) && k.release(),
		}
	};

	var tracked = (redraw) => {
		var {l: live, h: setHandle, r: remove} = trackedState(redraw);
		var initial = noop;
		var id = -1;
		return (state) => {
			if (!Object.is(initial, initial = state)) {
				remove(id++, 0);
				setHandle(id, state, 1);
			}
			return [...live]
		}
	};

	/* global fetch */


	var mfetch = async (url, opts = {}) => {
		checkCallback(opts.onprogress, true, "opts.onprogress");
		checkCallback(opts.extract, true, "opts.extract");

		try {
			var response = await fetch(url, opts);

			if (opts.onprogress && response.body) {
				var reader = response.body.getReader();
				var rawLength = response.headers.get("content-length") || "";
				// This is explicit coercion, but ESLint is frequently too dumb to detect it correctly.
				// Another example: https://github.com/eslint/eslint/issues/14623
				// eslint-disable-next-line no-implicit-coercion
				var total = (/^\d+$/).test(rawLength) ? +rawLength : -1;
				var current = 0;

				response = new Response(new ReadableStream({
					type: "bytes",
					start: (ctrl) => reader || ctrl.close(),
					cancel: (reason) => reader.cancel(reason),
					async pull(ctrl) {
						var result = await reader.read();
						if (result.done) {
							ctrl.close();
						} else {
							current += result.value.length;
							ctrl.enqueue(result.value);
							opts.onprogress(current, total);
						}
					},
				}), response);
			}

			if (response.ok) {
				if (opts.extract) {
					return await opts.extract(response)
				}

				switch (opts.responseType || "json") {
					case "json": return await response.json()
					case "formdata": return await response.formData()
					case "arraybuffer": return await response.arrayBuffer()
					case "blob": return await response.blob()
					case "text": return await response.text()
					case "document":
						// eslint-disable-next-line no-undef
						return new DOMParser()
							.parseFromString(await response.text(), response.headers.get("content-type") || "text/html")
					default:
						throw new TypeError(`Unknown response type: ${opts.responseType}`)
				}
			}

			var message = (await response.text()) || response.statusText;
		} catch (e) {
			var cause = e;
			var message = e.message;
		}

		var e = new Error(message);
		e.status = response ? response.status : 0;
		e.response = response;
		e.cause = cause;
		throw e
	};

	function Init({f}, old) {
		if (old) return m.retain()
		var ctrl = new AbortController();
		queueMicrotask(() => invokeRedrawable(this.redraw, f, undefined, ctrl.signal));
		return m.remove(() => ctrl.abort())
	}

	var init = (f) => m(Init, {f: checkCallback(f)});

	var lazy = (opts) => {
		checkCallback(opts.fetch, false, "opts.fetch");
		checkCallback(opts.pending, true, "opts.pending");
		checkCallback(opts.error, true, "opts.error");

		// Capture the error here so stack traces make more sense
		var error = new ReferenceError("Component not found");
		var redraws = new Set();
		var Comp = function () {
			redraws.add(checkCallback(this.redraw, false, "context.redraw"));
			return opts.pending && opts.pending()
		};
		var init = async () => {
			init = noop;
			try {
				Comp = await opts.fetch();
				if (typeof Comp !== "function") {
					Comp = Comp.default;
					if (typeof Comp !== "function") throw error
				}
			} catch (e) {
				console.error(e);
				Comp = () => opts.error && opts.error(e);
			}
			var r = redraws;
			redraws = null;
			for (var f of r) f();
		};

		return (attrs) => {
			init();
			return m(Comp, attrs)
		}
	};

	m.route = route;
	m.link = link;
	m.p = p;
	m.query = query;
	m.match = match;
	m.fetch = mfetch;
	m.lazy = lazy;
	m.init = init;
	m.tracked = tracked;
	m.trackedList = trackedList;
	m.throttler = throttler;
	m.debouncer = debouncer;

	/* global module: false, window: false */

	if (typeof module !== "undefined") module.exports = m;
	else window.m = m;

})();
//# sourceMappingURL=mithril.umd.js.map
