import { Boom } from "@hapi/boom";
import { randomBytes } from "crypto";
import { URL } from "url";
import { promisify } from "util";
import { proto } from "../../WAProto";
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER } from "../Defaults";
import { DisconnectReason } from "../Types";
import { addTransactionCapability, aesEncryptCTR, bindWaitForConnectionUpdate, bytesToCrockford, configureSuccessfulPairing, Curve, derivePairingCodeKey, generateLoginNode, generateMdTagPrefix, generateRegistrationNode, getCodeFromWSError, getErrorCodeFromStreamError, getNextPreKeysNode, getPlatformId, makeEventBuffer, makeNoiseHandler, printQRIfNecessaryListener, promiseTimeout } from "../Utils/index.js";
import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren, jidEncode, S_WHATSAPP_NET } from "../WABinary/index.js";
import { WebSocketClient } from "./Client/index.js";
export const makeSocket = (config) => {
    const url = typeof config.waWebSocketUrl === "string"
        ? new URL(config.waWebSocketUrl)
        : config.waWebSocketUrl;
    if (config.mobile || url.protocol === "tcp:") {
        throw new Boom("Mobile API is not supported anymore", {
            statusCode: DisconnectReason.loggedOut
        });
    }
    if (url.protocol === "wss" && config.auth?.creds?.routingInfo) {
        url.searchParams.append("ED", config.auth.creds.routingInfo.toString("base64url"));
    }
    const ws = new WebSocketClient(url, config);
    ws.connect();
    const ev = makeEventBuffer(config.logger);
    const ephemeralKeyPair = Curve.generateKeyPair();
    const noise = makeNoiseHandler({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: NOISE_WA_HEADER,
        logger: config.logger,
        routingInfo: config.auth?.creds?.routingInfo
    });
    const { creds } = config.auth;
    const keys = addTransactionCapability(config.auth.keys, config.logger, config.transactionOpts);
    const signalRepository = config.makeSignalRepository({ creds, keys });
    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;
    const uqTagId = generateMdTagPrefix();
    const generateMessageTag = () => `${uqTagId}${epoch++}`;
    const sendPromise = promisify(ws.send);
    const sendRawMessage = async (data) => {
        if (!ws.isOpen) {
            throw new Boom("Connection Closed", {
                statusCode: DisconnectReason.connectionClosed
            });
        }
        const bytes = noise.encodeFrame(data);
        await promiseTimeout(config.connectTimeoutMs, async (resolve, reject) => {
            try {
                await sendPromise.call(ws, bytes);
                resolve();
            }
            catch (error) {
                reject(error);
            }
        });
    };
    const sendNode = (frame) => {
        if (config.logger.level === "trace") {
            config.logger.trace({ xml: binaryNodeToString(frame), msg: "xml send" });
        }
        const buff = encodeBinaryNode(frame);
        return sendRawMessage(buff);
    };
    const onUnexpectedError = (err, msg) => {
        config.logger.error({ err }, `unexpected error in '${msg}'`);
    };
    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) {
            throw new Boom("Connection Closed", {
                statusCode: DisconnectReason.connectionClosed
            });
        }
        let onOpen;
        let onClose;
        const result = promiseTimeout(config.connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);
            ws.on("frame", onOpen);
            ws.on("close", onClose);
            ws.on("error", onClose);
        }).finally(() => {
            ws.off("frame", onOpen);
            ws.off("close", onClose);
            ws.off("error", onClose);
        });
        if (sendMsg) {
            sendRawMessage(sendMsg).catch(onClose);
        }
        return result;
    };
    const waitForMessage = async (msgId, timeoutMs = config.defaultQueryTimeoutMs) => {
        let onRecv;
        let onErr;
        try {
            return await promiseTimeout(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = (err) => {
                    reject(err ||
                        new Boom("Connection Closed", {
                            statusCode: DisconnectReason.connectionClosed
                        }));
                };
                ws.on(`TAG:${msgId}`, onRecv);
                ws.on("close", onErr);
                ws.off("error", onErr);
            });
        }
        finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off("close", onErr);
            ws.off("error", onErr);
        }
    };
    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) {
            node.attrs.id = generateMessageTag();
        }
        const msgId = node.attrs.id;
        const wait = waitForMessage(msgId, timeoutMs);
        await sendNode(node);
        const result = await wait;
        if ("tag" in result) {
            assertNodeErrorFree(result);
        }
        return result;
    };
    const validateConnection = async () => {
        let helloMsg = {
            clientHello: { ephemeral: ephemeralKeyPair.public }
        };
        helloMsg = proto.HandshakeMessage.fromObject(helloMsg);
        config.logger.info({ browser: config.browser, helloMsg }, "connected to WhatsApp");
        const init = proto.HandshakeMessage.encode(helloMsg).finish();
        const result = await awaitNextMessage(init);
        const handshake = proto.HandshakeMessage.decode(result);
        config.logger.trace({ handshake }, "handshake recv from WhatsApp");
        const keyEnc = noise.processHandshake(handshake, creds.noiseKey);
        let node;
        if (!creds.me) {
            node = generateRegistrationNode(creds, config);
            config.logger.info({ node }, "not logged in, attempting registration...");
        }
        else {
            node = generateLoginNode(creds.me.id, config);
            config.logger.info({ node }, "logging in...");
        }
        const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish());
        await sendRawMessage(proto.HandshakeMessage.encode({
            clientFinish: {
                static: keyEnc,
                payload: payloadEnc
            }
        }).finish());
        noise.finishInit();
        startKeepAliveRequest();
    };
    const getAvailablePreKeysOnServer = async () => {
        const result = await query({
            tag: "iq",
            attrs: {
                id: generateMessageTag(),
                xmlns: "encrypt",
                type: "get",
                to: S_WHATSAPP_NET
            },
            content: [{ tag: "count", attrs: {} }]
        });
        const countChild = getBinaryNodeChild(result, "count");
        return +countChild.attrs.value;
    };
    const uploadPreKeys = async (count = INITIAL_PREKEY_COUNT) => {
        await keys.transaction(async () => {
            config.logger.info({ count }, "uploading pre-keys");
            const { update, node } = await getNextPreKeysNode({ creds, keys }, count);
            await query(node);
            ev.emit("creds.update", update);
            config.logger.info({ count }, "uploaded pre-keys");
        });
    };
    const uploadPreKeysToServerIfRequired = async () => {
        const preKeyCount = await getAvailablePreKeysOnServer();
        config.logger.info(`${preKeyCount} pre-keys found on server`);
        if (preKeyCount <= MIN_PREKEY_COUNT) {
            await uploadPreKeys();
        }
    };
    const onMessageReceived = (data) => {
        noise.decodeFrame(data, (frame) => {
            lastDateRecv = new Date();
            let anyTriggered = false;
            anyTriggered = ws.emit("frame", frame);
            if (!(frame instanceof Uint8Array)) {
                const msgId = frame.attrs.id;
                if (config.logger.level === "trace") {
                    config.logger.trace({
                        xml: binaryNodeToString(frame),
                        msg: "recv xml"
                    });
                }
                anyTriggered =
                    ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered;
                const l0 = frame.tag;
                const l1 = frame.attrs || {};
                const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : "";
                for (const key of Object.keys(l1)) {
                    anyTriggered =
                        ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered;
                    anyTriggered =
                        ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) ||
                            anyTriggered;
                    anyTriggered =
                        ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) ||
                            anyTriggered;
                }
                anyTriggered =
                    ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered;
                anyTriggered =
                    ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered;
                if (!anyTriggered && config.logger.level === "debug") {
                    config.logger.debug({ unhandled: true, msgId, fromMe: false, frame }, "communication recv");
                }
            }
        });
    };
    const end = (error) => {
        if (closed) {
            config.logger.trace({ trace: error?.stack }, "connection already closed");
            return;
        }
        closed = true;
        config.logger.info({ trace: error?.stack }, error ? "connection errored" : "connection closed");
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners("close");
        ws.removeAllListeners("error");
        ws.removeAllListeners("open");
        ws.removeAllListeners("message");
        if (!ws.isClosed && !ws.isClosing) {
            ws.close().catch(() => void 0);
        }
        ev.emit("connection.update", {
            connection: "close",
            lastDisconnect: {
                error,
                date: new Date()
            }
        });
        ev.removeAllListeners("connection.update");
    };
    const waitForSocketOpen = async () => {
        if (ws.isOpen) {
            return;
        }
        if (ws.isClosed || ws.isClosing) {
            throw new Boom("Connection Closed", {
                statusCode: DisconnectReason.connectionClosed
            });
        }
        let onOpen;
        let onClose;
        await new Promise((resolve, reject) => {
            onOpen = () => resolve(undefined);
            onClose = mapWebSocketError(reject);
            ws.on("open", onOpen);
            ws.on("close", onClose);
            ws.on("error", onClose);
        }).finally(() => {
            ws.off("open", onOpen);
            ws.off("close", onClose);
            ws.off("error", onClose);
        });
    };
    const startKeepAliveRequest = () => (keepAliveReq = setInterval(() => {
        if (!lastDateRecv) {
            lastDateRecv = new Date();
        }
        const diff = Date.now() - lastDateRecv.getTime();
        if (diff > config.keepAliveIntervalMs + 5000) {
            end(new Boom("Connection was lost", {
                statusCode: DisconnectReason.connectionLost
            }));
        }
        else if (ws.isOpen) {
            query({
                tag: "iq",
                attrs: {
                    id: generateMessageTag(),
                    to: S_WHATSAPP_NET,
                    type: "get",
                    xmlns: "w:p"
                },
                content: [{ tag: "ping", attrs: {} }]
            }).catch((err) => {
                config.logger.error({ trace: err.stack }, "error in sending keep alive");
            });
        }
        else {
            config.logger.warn("keep alive called when WS not open");
        }
    }, config.keepAliveIntervalMs));
    const sendPassiveIq = (tag) => query({
        tag: "iq",
        attrs: {
            to: S_WHATSAPP_NET,
            xmlns: "passive",
            type: "set"
        },
        content: [{ tag, attrs: {} }]
    });
    const logout = async (msg) => {
        const jid = config.auth.creds.me?.id;
        if (jid) {
            await sendNode({
                tag: "iq",
                attrs: {
                    to: S_WHATSAPP_NET,
                    type: "set",
                    id: generateMessageTag(),
                    xmlns: "md"
                },
                content: [
                    {
                        tag: "remove-companion-device",
                        attrs: {
                            jid,
                            reason: "user_initiated"
                        }
                    }
                ]
            });
        }
        end(new Boom(msg || "Intentional Logout", {
            statusCode: DisconnectReason.loggedOut
        }));
    };
    const requestPairingCode = async (phoneNumber) => {
        config.auth.creds.pairingCode = bytesToCrockford(randomBytes(5));
        config.auth.creds.me = {
            id: jidEncode(phoneNumber, "s.whatsapp.net"),
            name: "~"
        };
        ev.emit("creds.update", config.auth.creds);
        await sendNode({
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                type: "set",
                id: generateMessageTag(),
                xmlns: "md"
            },
            content: [
                {
                    tag: "link_code_companion_reg",
                    attrs: {
                        jid: config.auth.creds.me.id,
                        stage: "companion_hello",
                        should_show_push_notification: "true"
                    },
                    content: [
                        {
                            tag: "link_code_pairing_wrapped_companion_ephemeral_pub",
                            attrs: {},
                            content: await generatePairingKey()
                        },
                        {
                            tag: "companion_server_auth_key_pub",
                            attrs: {},
                            content: config.auth.creds.noiseKey.public
                        },
                        {
                            tag: "companion_platform_id",
                            attrs: {},
                            content: getPlatformId(config.browser[1])
                        },
                        {
                            tag: "companion_platform_display",
                            attrs: {},
                            content: `${config.browser[1]} (${config.browser[0]})`
                        },
                        {
                            tag: "link_code_pairing_nonce",
                            attrs: {},
                            content: "0"
                        }
                    ]
                }
            ]
        });
        return config.auth.creds.pairingCode;
    };
    async function generatePairingKey() {
        const salt = randomBytes(32);
        const randomIv = randomBytes(16);
        const key = await derivePairingCodeKey(config.auth.creds.pairingCode, salt);
        const ciphered = aesEncryptCTR(config.auth.creds.pairingEphemeralKeyPair.public, key, randomIv);
        return Buffer.concat([salt, randomIv, ciphered]);
    }
    const sendWAMBuffer = (wamBuffer) => {
        return query({
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                id: generateMessageTag(),
                xmlns: "w:stats"
            },
            content: [
                {
                    tag: "add",
                    attrs: {},
                    content: wamBuffer
                }
            ]
        });
    };
    ws.on("message", onMessageReceived);
    ws.on("open", async () => {
        try {
            await validateConnection();
        }
        catch (err) {
            config.logger.error({ err }, "error in validating connection");
            end(err);
        }
    });
    ws.on("error", mapWebSocketError(end));
    ws.on("close", () => end(new Boom("Connection Terminated", {
        statusCode: DisconnectReason.connectionClosed
    })));
    ws.on("CB:xmlstreamend", () => end(new Boom("Connection Terminated by Server", {
        statusCode: DisconnectReason.connectionClosed
    })));
    ws.on("CB:iq,type:set,pair-device", async (stanza) => {
        const iq = {
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                type: "result",
                id: stanza.attrs.id
            }
        };
        await sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(stanza, "pair-device");
        const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref");
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString("base64");
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString("base64");
        const advB64 = creds.advSecretKey;
        let qrMs = config.qrTimeout || 60_000;
        const genPairQR = () => {
            if (!ws.isOpen) {
                return;
            }
            const refNode = refNodes.shift();
            if (!refNode) {
                end(new Boom("QR refs attempts ended", {
                    statusCode: DisconnectReason.timedOut
                }));
                return;
            }
            const ref = refNode.content.toString("utf-8");
            const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(",");
            ev.emit("connection.update", { qr });
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = config.qrTimeout || 20_000;
        };
        genPairQR();
    });
    ws.on("CB:iq,,pair-success", async (stanza) => {
        config.logger.debug("pair success recv");
        try {
            const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds);
            config.logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, "pairing configured successfully, expect to restart the connection...");
            ev.emit("creds.update", updatedCreds);
            ev.emit("connection.update", { isNewLogin: true, qr: undefined });
            await sendNode(reply);
        }
        catch (error) {
            config.logger.info({ trace: error.stack }, "error in pairing");
            end(error);
        }
    });
    ws.on("CB:success", async (node) => {
        await uploadPreKeysToServerIfRequired();
        await sendPassiveIq("active");
        config.logger.info("opened connection to WhatsApp");
        clearTimeout(qrTimer);
        ev.emit("creds.update", {
            me: { ...config.auth.creds.me, lid: node.attrs.lid }
        });
        ev.emit("connection.update", { connection: "open" });
    });
    ws.on("CB:stream:error", (node) => {
        config.logger.error({ node }, "stream errored out");
        const { reason, statusCode } = getErrorCodeFromStreamError(node);
        end(new Boom(`Stream Errored (${reason})`, { statusCode, data: node }));
    });
    ws.on("CB:failure", (node) => {
        const reason = +(node.attrs.reason || 500);
        end(new Boom("Connection Failure", { statusCode: reason, data: node.attrs }));
    });
    ws.on("CB:ib,,downgrade_webclient", () => {
        end(new Boom("Multi-device beta not joined", {
            statusCode: DisconnectReason.multideviceMismatch
        }));
    });
    ws.on("CB:ib,,offline_preview", (node) => {
        config.logger.info("offline preview received", node);
        sendNode({
            tag: "ib",
            attrs: {},
            content: [{ tag: "offline_batch", attrs: { count: "100" } }]
        });
    });
    ws.on("CB:ib,,edge_routing", (node) => {
        const edgeRoutingNode = getBinaryNodeChild(node, "edge_routing");
        const routingInfo = getBinaryNodeChild(edgeRoutingNode, "routing_info");
        if (routingInfo?.content) {
            config.auth.creds.routingInfo = Buffer.from(routingInfo?.content);
            ev.emit("creds.update", config.auth.creds);
        }
    });
    let didStartBuffer = false;
    process.nextTick(() => {
        if (creds.me?.id) {
            ev.buffer();
            didStartBuffer = true;
        }
        ev.emit("connection.update", {
            connection: "connecting",
            receivedPendingNotifications: false,
            qr: undefined
        });
    });
    ws.on("CB:ib,,offline", (node) => {
        const child = getBinaryNodeChild(node, "offline");
        const offlineNotifs = +(child?.attrs.count || 0);
        config.logger.info(`handled ${offlineNotifs} offline messages/notifications`);
        if (didStartBuffer) {
            ev.flush();
            config.logger.trace("flushed events for initial buffer");
        }
        ev.emit("connection.update", { receivedPendingNotifications: true });
    });
    ev.on("creds.update", (update) => {
        const name = update.me?.name;
        if (creds.me?.name !== name) {
            config.logger.debug({ name }, "updated pushName");
            sendNode({
                tag: "presence",
                attrs: { name: name }
            }).catch((err) => {
                config.logger.warn({ trace: err.stack }, "error in sending presence update on name change");
            });
        }
        Object.assign(creds, update);
    });
    if (config.printQRInTerminal) {
        printQRIfNecessaryListener(ev, config.logger);
    }
    return {
        type: "md",
        ws,
        ev,
        authState: { creds, keys },
        signalRepository,
        get user() {
            return config.auth.creds.me;
        },
        generateMessageTag,
        query,
        waitForMessage,
        waitForSocketOpen,
        sendRawMessage,
        sendNode,
        logout,
        end,
        onUnexpectedError,
        uploadPreKeys,
        uploadPreKeysToServerIfRequired,
        requestPairingCode,
        waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
        sendWAMBuffer
    };
};
function mapWebSocketError(handler) {
    return (error) => {
        handler(new Boom(`WebSocket Error (${error?.message})`, {
            statusCode: getCodeFromWSError(error),
            data: error
        }));
    };
}
