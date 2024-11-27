function extend(object, methods, callback) {
    const allMethods = Array.isArray(methods) ? methods : [methods];

    allMethods.forEach((method) => {
        const original = object[method];

        object[method] = function (...args) {
            const value = original ? original.apply(this, args) : undefined;
            callback.apply(this, [value, ...args]);
            return value;
        };

        Object.assign(object[method], original);
    });
}

function override(object, methods, newMethod) {
    const allMethods = Array.isArray(methods) ? methods : [methods];

    allMethods.forEach((method) => {
        const original = object[method];

        object[method] = function (...args) {
            return newMethod.apply(this, [original?.bind(this), ...args]);
        };

        Object.assign(object[method], original);
    });
}
