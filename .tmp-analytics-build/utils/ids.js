"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shortId = shortId;
const crypto_1 = require("crypto");
function shortId() {
    return (0, crypto_1.randomUUID)().replace(/-/g, "").slice(0, 12);
}
