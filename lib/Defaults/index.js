import { proto } from "../../WAProto/index.js";
import { makeLibSignalRepository } from "../Signal/libsignal.js";
import { Browsers } from "../Utils/index.js";
import logger from "../Utils/logger.js";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
export const UNAUTHORIZED_CODES = [401, 403, 419];
export const DEFAULT_ORIGIN = "https://web.whatsapp.com";
export const DEF_CALLBACK_PREFIX = "CB:";
export const DEF_TAG_PREFIX = "TAG:";
export const PHONE_CONNECTION_CB = "CB:Pong";
export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60;
export const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
export const DICT_VERSION = 2;
export const KEY_BUNDLE_TYPE = Buffer.from([5]);
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]);
export const URL_REGEX = /(http(s)?:\/\/.)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/;
export const WA_CERT_DETAILS = {
    SERIAL: 0
};
const require = createRequire(import.meta.url);
const version = require(path.join(fileURLToPath(import.meta.url), "baileys-version.json")).version;
export const PROCESSABLE_HISTORY_TYPES = [
    proto.Message.HistorySyncNotification.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.Message.HistorySyncNotification.HistorySyncType.PUSH_NAME,
    proto.Message.HistorySyncNotification.HistorySyncType.RECENT,
    proto.Message.HistorySyncNotification.HistorySyncType.FULL,
    proto.Message.HistorySyncNotification.HistorySyncType.ON_DEMAND
];
export const DEFAULT_CONNECTION_CONFIG = {
    version: version,
    browser: Browsers.ubuntu("Chrome"),
    waWebSocketUrl: "wss://web.whatsapp.com/ws/chat",
    connectTimeoutMs: 20_000,
    keepAliveIntervalMs: 30_000,
    logger: logger.child({ class: "baileys" }),
    printQRInTerminal: false,
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60_000,
    customUploadHosts: [],
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    fireInitQueries: true,
    auth: undefined,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    patchMessageBeforeSending: (msg) => msg,
    shouldSyncHistoryMessage: () => true,
    shouldIgnoreJid: () => false,
    linkPreviewImageThumbnailWidth: 192,
    transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
    generateHighQualityLinkPreview: false,
    options: {},
    appStateMacVerification: {
        patch: false,
        snapshot: false
    },
    countryCode: "US",
    getMessage: async () => undefined,
    cachedGroupMetadata: async () => undefined,
    makeSignalRepository: makeLibSignalRepository
};
export const MEDIA_PATH_MAP = {
    image: "/mms/image",
    video: "/mms/video",
    document: "/mms/document",
    audio: "/mms/audio",
    sticker: "/mms/image",
    "thumbnail-link": "/mms/image",
    "product-catalog-image": "/product/image",
    "md-app-state": "",
    "md-msg-hist": "/mms/md-app-state"
};
export const MEDIA_HKDF_KEY_MAPPING = {
    audio: "Audio",
    document: "Document",
    gif: "Video",
    image: "Image",
    ppic: "",
    product: "Image",
    ptt: "Audio",
    sticker: "Image",
    video: "Video",
    "thumbnail-document": "Document Thumbnail",
    "thumbnail-image": "Image Thumbnail",
    "thumbnail-video": "Video Thumbnail",
    "thumbnail-link": "Link Thumbnail",
    "md-msg-hist": "History",
    "md-app-state": "App State",
    "product-catalog-image": "",
    "payment-bg-image": "Payment Background",
    ptv: "Video"
};
export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP);
export const MIN_PREKEY_COUNT = 5;
export const INITIAL_PREKEY_COUNT = 30;
export const DEFAULT_CACHE_TTLS = {
    SIGNAL_STORE: 5 * 60,
    MSG_RETRY: 60 * 60,
    CALL_OFFER: 5 * 60,
    USER_DEVICES: 5 * 60
};
