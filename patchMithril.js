function isClass(x) {
    return typeof x === 'function' && x.prototype && !Object.getOwnPropertyDescriptor(x, 'prototype').writable;
}

function createComponentFunc(comp) {
    return function (attrs, old, context) {
        const inst = old?._cInst ?? new comp();
        inst.redraw = this.redraw;
        attrs._cInst = inst;

        return inst.view.apply(inst, [attrs, old, context]);
    }
}

const componentFuncs = new Map();

function patchMithril(global) {
    const defaultMithril = global.m;

    const modifiedMithril = function (comp, ...args) {
        const mArgs = [comp, ...args];

        if (isClass(comp)) {
            let func = componentFuncs.get(comp);
            if (!func) {
                componentFuncs.set(comp, func = createComponentFunc(comp));
            }
            mArgs[0] = func;
        }

        const node = defaultMithril.apply(this, mArgs);

        return node;
    };

    Object.keys(defaultMithril).forEach((key) => (modifiedMithril[key] = defaultMithril[key]));

    global.m = modifiedMithril;
}

patchMithril(window);