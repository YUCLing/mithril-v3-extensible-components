A attempt on creating extensible component system with Mithril v3.

Both `extend` and `override` come from [Flarum](https://github.com/flarum/framework).

The included Mithril is built from https://github.com/dead-claudia/mithril.js/tree/7c5d9b7faa5df280978f3c342567b40083fbd05f

# Implementations

## Function Components

This approach is supported by Mithril natively. But currently lack of a easy way to do something like extending in class.

It also requires some more work to make state sharing between render function itself and sub functions to work.

- `func_app.js`

## Class Components

This approach requires patching Mithril to bring back the object component.

- `patchMithril.js`
- `app.js`