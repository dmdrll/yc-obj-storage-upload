"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
exports.upload = upload;
exports.clearBucket = clearBucket;
const core_1 = require("@actions/core");
const client_s3_1 = require("@aws-sdk/client-s3");
const lib_storage_1 = require("@aws-sdk/lib-storage");
const protocol_http_1 = require("@smithy/protocol-http");
const iam_token_service_1 = require("@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service");
const fs_1 = require("fs");
const glob_1 = require("glob");
const mime_types_1 = __importDefault(require("mime-types"));
const minimatch_1 = require("minimatch");
const node_path_1 = __importDefault(require("node:path"));
const service_account_json_1 = require("./service-account-json");
const cache_control_1 = require("./cache-control");
const middleware_flexible_checksums_1 = require("@aws-sdk/middleware-flexible-checksums");
const axios_1 = __importDefault(require("axios"));
async function run() {
    try {
        let sessionConfig = {};
        const ycSaJsonCredentials = (0, core_1.getInput)('yc-sa-json-credentials');
        const ycIamToken = (0, core_1.getInput)('yc-iam-token');
        const ycSaId = (0, core_1.getInput)('yc-sa-id');
        if (ycSaJsonCredentials !== '') {
            const serviceAccountJson = (0, service_account_json_1.fromServiceAccountJsonFile)(JSON.parse(ycSaJsonCredentials));
            (0, core_1.info)('Parsed Service account JSON');
            sessionConfig = { serviceAccountJson };
        }
        else if (ycIamToken !== '') {
            sessionConfig = { iamToken: ycIamToken };
            (0, core_1.info)('Using IAM token');
        }
        else if (ycSaId !== '') {
            const ghToken = await (0, core_1.getIDToken)();
            if (!ghToken) {
                throw new Error('No credentials provided');
            }
            const saToken = await exchangeToken(ghToken, ycSaId);
            sessionConfig = { iamToken: saToken };
        }
        else {
            throw new Error('No credentials');
        }
        const inputs = {
            bucket: (0, core_1.getInput)('bucket', { required: true }),
            prefix: (0, core_1.getInput)('prefix', { required: false }),
            root: (0, core_1.getInput)('root', { required: true }),
            include: (0, core_1.getMultilineInput)('include', { required: false }),
            exclude: (0, core_1.getMultilineInput)('exclude', { required: false }),
            clear: (0, core_1.getBooleanInput)('clear', { required: false }),
            cacheControl: (0, cache_control_1.parseCacheControlFormats)((0, core_1.getMultilineInput)('cache-control', { required: false }))
        };
        // Initialize Token service with your SA credentials
        let tokenService;
        if ('serviceAccountJson' in sessionConfig) {
            tokenService = new iam_token_service_1.IamTokenService(sessionConfig.serviceAccountJson);
        }
        else {
            tokenService = {
                getToken: async () => {
                    const iamToken = sessionConfig.iamToken;
                    if (!iamToken) {
                        throw new Error('No IAM token provided');
                    }
                    return iamToken;
                }
            };
        }
        const s3Client = new client_s3_1.S3Client({
            region: 'kz1',
            endpoint: 'https://storage.yandexcloud.kz/',
            requestChecksumCalculation: middleware_flexible_checksums_1.RequestChecksumCalculation.WHEN_REQUIRED,
            responseChecksumValidation: middleware_flexible_checksums_1.ResponseChecksumValidation.WHEN_REQUIRED
        });
        // eslint-disable-next-line  @typescript-eslint/no-explicit-any
        const middleware = next => {
            return async (args) => {
                if (!protocol_http_1.HttpRequest.isInstance(args.request)) {
                    return next(args);
                }
                args.request.headers['X-YaCloud-SubjectToken'] = await tokenService.getToken();
                return next(args);
            };
        };
        s3Client.middlewareStack.removeByTag('HTTP_AUTH_SCHEME');
        s3Client.middlewareStack.removeByTag('HTTP_SIGNING');
        s3Client.middlewareStack.addRelativeTo(middleware, {
            name: 'ycAuthMiddleware',
            tags: ['YCAUTH'],
            relation: 'after',
            toMiddleware: 'retryMiddleware',
            override: true
        });
        if (inputs.clear) {
            await clearBucket(s3Client, inputs.bucket);
        }
        await upload(s3Client, inputs);
    }
    catch (err) {
        if (err instanceof Error) {
            (0, core_1.setFailed)(err.message);
        }
    }
}
const uploadFile = async (client, filePath, { root, bucket, prefix, cacheControl }) => {
    const stat = (0, fs_1.statSync)(filePath);
    if (stat.isDirectory()) {
        return;
    }
    const contentType = mime_types_1.default.lookup(filePath) || 'text/plain';
    let key = node_path_1.default.relative(root, filePath);
    if (prefix) {
        key = node_path_1.default.join(prefix, key);
    }
    try {
        (0, core_1.info)(`starting to upload ${key}`);
        const parallelUploads3 = new lib_storage_1.Upload({
            client,
            params: {
                Bucket: bucket,
                Key: key,
                Body: (0, fs_1.createReadStream)(filePath),
                ContentType: contentType,
                CacheControl: (0, cache_control_1.getCacheControlValue)(cacheControl, key)
            },
            queueSize: 4,
            leavePartsOnError: false
        });
        return await parallelUploads3.done();
    }
    catch (e) {
        (0, core_1.error)(`${e}`);
    }
};
async function upload(s3Client, inputs) {
    (0, core_1.startGroup)('Upload');
    try {
        (0, core_1.info)('Upload start');
        const workspace = process.env['GITHUB_WORKSPACE'] ?? '';
        const patterns = parseIgnoreGlobPatterns(inputs.exclude);
        const root = node_path_1.default.join(workspace, inputs.root);
        for (const include of inputs.include) {
            let pathFromSourceRoot = node_path_1.default.join(root, include);
            if (!pathFromSourceRoot.includes('*')) {
                try {
                    const stat = (0, fs_1.statSync)(pathFromSourceRoot);
                    if (stat.isDirectory()) {
                        pathFromSourceRoot = node_path_1.default.join(pathFromSourceRoot, '*');
                    }
                }
                catch (e) {
                    (0, core_1.debug)(`${e}`);
                }
            }
            const matches = glob_1.glob.sync(pathFromSourceRoot, { absolute: false });
            for (const match of matches) {
                const res = !patterns.map(p => (0, minimatch_1.minimatch)(match, p, { matchBase: true })).some(x => x);
                if (res) {
                    await uploadFile(s3Client, match, {
                        ...inputs,
                        root
                    });
                }
            }
        }
    }
    finally {
        (0, core_1.endGroup)();
    }
}
function parseIgnoreGlobPatterns(patterns) {
    const result = [];
    for (const pattern of patterns) {
        //only not empty patterns
        if (pattern?.length > 0) {
            result.push(pattern);
        }
    }
    (0, core_1.info)(`Source ignore pattern: "${JSON.stringify(result)}"`);
    return result;
}
async function clearBucket(client, bucket) {
    (0, core_1.info)('Clearing bucket');
    const listCommand = new client_s3_1.ListObjectsV2Command({
        Bucket: bucket,
        // The default and maximum number of keys returned is 1000.
        MaxKeys: 1000
    });
    let isTruncated = true;
    let totalDeleted = 0;
    while (isTruncated) {
        const { Contents, IsTruncated, NextContinuationToken } = await client.send(listCommand);
        if (!Contents || Contents.length === 0) {
            break;
        }
        isTruncated = Boolean(IsTruncated);
        listCommand.input.ContinuationToken = NextContinuationToken;
        const deleteCommand = new client_s3_1.DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: Contents.map(c => ({ Key: c.Key }))
            }
        });
        const { Deleted } = await client.send(deleteCommand);
        totalDeleted += Deleted?.length ?? 0;
    }
    (0, core_1.info)(`Deleted ${totalDeleted} objects from bucket ${bucket}`);
}
async function exchangeToken(token, saId) {
    (0, core_1.info)(`Exchanging token for service account ${saId}`);
    const res = await axios_1.default.post('https://auth.yandex.cloud/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: saId,
        subject_token: token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
    }, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    if (res.status !== 200) {
        throw new Error(`Failed to exchange token: ${res.status} ${res.statusText}`);
    }
    if (!res.data.access_token) {
        throw new Error(`Failed to exchange token: ${res.data.error} ${res.data.error_description}`);
    }
    (0, core_1.info)(`Token exchanged successfully`);
    return res.data.access_token;
}
//# sourceMappingURL=main.js.map