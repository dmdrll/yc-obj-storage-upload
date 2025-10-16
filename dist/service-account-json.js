"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromServiceAccountJsonFile = fromServiceAccountJsonFile;
function fromServiceAccountJsonFile(data) {
    return {
        accessKeyId: data.id,
        privateKey: data.private_key,
        serviceAccountId: data.service_account_id
    };
}
//# sourceMappingURL=service-account-json.js.map