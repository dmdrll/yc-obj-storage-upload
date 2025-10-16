"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newCacheControlConfig = newCacheControlConfig;
exports.parseCacheControlFormats = parseCacheControlFormats;
exports.getCacheControlValue = getCacheControlValue;
const minimatch_1 = require("minimatch");
function newCacheControlConfig() {
    return {
        mapping: new Map(),
        default: undefined
    };
}
function parseCacheControlFormats(formats) {
    const result = new Map();
    for (const format of formats) {
        const [keysPart, valuePart] = format.split(':');
        const keys = keysPart.split(',').map(key => key.trim());
        const value = valuePart.trim();
        for (const key of keys) {
            result.set(key, value);
        }
    }
    let defaultCacheControl = result.get('*')?.trim();
    if (defaultCacheControl === '') {
        defaultCacheControl = undefined;
    }
    if (result.has('*')) {
        result.delete('*');
    }
    return {
        mapping: result,
        default: defaultCacheControl
    };
}
function getCacheControlValue(cacheControl, key) {
    for (const [pattern, value] of cacheControl.mapping) {
        if (minimatch_1.minimatch.match([key], pattern, { matchBase: true }).length > 0) {
            return value;
        }
    }
    if (cacheControl.default) {
        return cacheControl.default;
    }
}
//# sourceMappingURL=cache-control.js.map