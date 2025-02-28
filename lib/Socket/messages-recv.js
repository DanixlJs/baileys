import { Boom } from "@hapi/boom";
import { randomBytes } from "crypto";
import NodeCache from "@cacheable/node-cache";
import { proto } from "../../WAProto/index.js";
import { DEFAULT_CACHE_TTLS, KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT } from "../Defaults/index.js";
import { WAMessageStatus, WAMessageStubType } from "../Types";
import { aesDecryptCTR, aesEncryptGCM, Curve, decodeMediaRetryNode, decodeMessageNode, decryptMessageNode, delay, derivePairingCodeKey, encodeBigEndian, encodeSignedDeviceIdentity, getCallStatusFromNode, getHistoryMsg, getNextPreKeys, getStatusFromReceiptType, hkdf, MISSING_KEYS_ERROR_TEXT, NACK_REASONS, NO_MESSAGE_FOUND_ERROR_TEXT, unixTimestampSeconds, xmppPreKey, xmppSignedPreKey, cleanMessage } from "../Utils/index.js";
import { makeMutex } from "../Utils/make-mutex.js";
import { areJidsSameUser, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, isJidGroup, isJidStatusBroadcast, isJidUser, jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from "../WABinary/index.js";
import { extractGroupMetadata } from "./groups.js";
import { makeMessagesSocket } from "./messages-send.js";
export const makeMessagesRecvSocket = (config) => {
    const sock = makeMessagesSocket(config);
    const retryMutex = makeMutex();
    const msgRetryCache = config.msgRetryCounterCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
            useClones: false
        });
    const callOfferCache = config.callOfferCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER,
            useClones: false
        });
    const placeholderResendCache = config.placeholderResendCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
            useClones: false
        });
    let sendActiveReceipts = false;
    const sendMessageAck = async ({ tag, attrs, content }, errorCode) => {
        const stanza = {
            tag: "ack",
            attrs: {
                id: attrs.id,
                to: attrs.from,
                class: tag
            }
        };
        if (errorCode) {
            stanza.attrs.error = errorCode.toString();
        }
        if (attrs.participant) {
            stanza.attrs.participant = attrs.participant;
        }
        if (attrs.recipient) {
            stanza.attrs.recipient = attrs.recipient;
        }
        if (attrs.type &&
            (tag !== "message" ||
                getBinaryNodeChild({ tag, attrs, content }, "unavailable") ||
                errorCode !== 0)) {
            stanza.attrs.type = attrs.type;
        }
        if (tag === "message" &&
            getBinaryNodeChild({ tag, attrs, content }, "unavailable")) {
            stanza.attrs.from = sock.authState.creds.me.id;
        }
        config.logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, "sent ack");
        await sock.sendNode(stanza);
    };
    const rejectCall = async (callId, callFrom) => {
        const stanza = {
            tag: "call",
            attrs: {
                from: sock.authState.creds.me.id,
                to: callFrom
            },
            content: [
                {
                    tag: "reject",
                    attrs: {
                        "call-id": callId,
                        "call-creator": callFrom,
                        count: "0"
                    },
                    content: undefined
                }
            ]
        };
        await sock.query(stanza);
    };
    const sendRetryRequest = async (node, forceIncludeKeys = false) => {
        const { fullMessage } = decodeMessageNode(node, sock.authState.creds.me.id, sock.authState.creds.me.lid || "");
        const { key: msgKey } = fullMessage;
        const msgId = msgKey.id;
        const key = `${msgId}:${msgKey?.participant}`;
        let retryCount = msgRetryCache.get(key) || 0;
        if (retryCount >= config.maxMsgRetryCount) {
            config.logger.debug({ retryCount, msgId }, "reached retry limit, clearing");
            msgRetryCache.del(key);
            return;
        }
        retryCount += 1;
        msgRetryCache.set(key, retryCount);
        const { account, signedPreKey, signedIdentityKey: identityKey } = sock.authState.creds;
        if (retryCount === 1) {
            const msgId = await requestPlaceholderResend(msgKey);
            config.logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`);
        }
        const deviceIdentity = encodeSignedDeviceIdentity(account, true);
        await sock.authState.keys.transaction(async () => {
            const receipt = {
                tag: "receipt",
                attrs: {
                    id: msgId,
                    type: "retry",
                    to: node.attrs.from
                },
                content: [
                    {
                        tag: "retry",
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: "1"
                        }
                    },
                    {
                        tag: "registration",
                        attrs: {},
                        content: encodeBigEndian(sock.authState.creds.registrationId)
                    }
                ]
            };
            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient;
            }
            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant;
            }
            if (retryCount > 1 || forceIncludeKeys) {
                const { update, preKeys } = await getNextPreKeys(sock.authState, 1);
                const [keyId] = Object.keys(preKeys);
                const key = preKeys[+keyId];
                const content = receipt.content;
                content.push({
                    tag: "keys",
                    attrs: {},
                    content: [
                        { tag: "type", attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
                        { tag: "identity", attrs: {}, content: identityKey.public },
                        xmppPreKey(key, +keyId),
                        xmppSignedPreKey(signedPreKey),
                        { tag: "device-identity", attrs: {}, content: deviceIdentity }
                    ]
                });
                sock.ev.emit("creds.update", update);
            }
            await sock.sendNode(receipt);
            config.logger.info({ msgAttrs: node.attrs, retryCount }, "sent retry receipt");
        });
    };
    const handleEncryptNotification = async (node) => {
        const from = node.attrs.from;
        if (from === S_WHATSAPP_NET) {
            const countChild = getBinaryNodeChild(node, "count");
            const count = +countChild.attrs.value;
            const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT;
            config.logger.debug({ count, shouldUploadMorePreKeys }, "recv pre-key count");
            if (shouldUploadMorePreKeys) {
                await sock.uploadPreKeys();
            }
        }
        else {
            const identityNode = getBinaryNodeChild(node, "identity");
            if (identityNode) {
                config.logger.info({ jid: from }, "identity changed");
            }
            else {
                config.logger.info({ node }, "unknown encrypt notification");
            }
        }
    };
    const handleGroupNotification = (participant, child, msg) => {
        const participantJid = getBinaryNodeChild(child, "participant")?.attrs?.jid || participant;
        switch (child?.tag) {
            case "create":
                const metadata = extractGroupMetadata(child);
                msg.messageStubType = WAMessageStubType.GROUP_CREATE;
                msg.messageStubParameters = [metadata.subject];
                msg.key = { participant: metadata.owner };
                sock.ev.emit("chats.upsert", [
                    {
                        id: metadata.id,
                        name: metadata.subject,
                        conversationTimestamp: metadata.creation
                    }
                ]);
                sock.ev.emit("groups.upsert", [
                    {
                        ...metadata,
                        author: participant
                    }
                ]);
                break;
            case "ephemeral":
            case "not_ephemeral":
                msg.message = {
                    protocolMessage: {
                        type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                        ephemeralExpiration: +(child.attrs.expiration || 0)
                    }
                };
                break;
            case "modify":
                const oldNumber = getBinaryNodeChildren(child, "participant").map((p) => p.attrs.jid);
                msg.messageStubParameters = oldNumber || [];
                msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER;
                break;
            case "promote":
            case "demote":
            case "remove":
            case "add":
            case "leave":
                const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`;
                msg.messageStubType = WAMessageStubType[stubType];
                const participants = getBinaryNodeChildren(child, "participant").map((p) => p.attrs.jid);
                if (participants.length === 1 &&
                    areJidsSameUser(participants[0], participant) &&
                    child.tag === "remove") {
                    msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE;
                }
                msg.messageStubParameters = participants;
                break;
            case "subject":
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT;
                msg.messageStubParameters = [child.attrs.subject];
                break;
            case "description":
                const description = getBinaryNodeChild(child, "body")?.content?.toString();
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION;
                msg.messageStubParameters = description ? [description] : undefined;
                break;
            case "announcement":
            case "not_announcement":
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE;
                msg.messageStubParameters = [
                    child.tag === "announcement" ? "on" : "off"
                ];
                break;
            case "locked":
            case "unlocked":
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT;
                msg.messageStubParameters = [child.tag === "locked" ? "on" : "off"];
                break;
            case "invite":
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK;
                msg.messageStubParameters = [child.attrs.code];
                break;
            case "member_add_mode":
                const addMode = child.content;
                if (addMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE;
                    msg.messageStubParameters = [addMode.toString()];
                }
                break;
            case "membership_approval_mode":
                const approvalMode = getBinaryNodeChild(child, "group_join");
                if (approvalMode) {
                    msg.messageStubType =
                        WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE;
                    msg.messageStubParameters = [approvalMode.attrs.state];
                }
                break;
            case "created_membership_requests":
                msg.messageStubType =
                    WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [
                    participantJid,
                    "created",
                    child.attrs.request_method
                ];
                break;
            case "revoked_membership_requests":
                const isDenied = areJidsSameUser(participantJid, participant);
                msg.messageStubType =
                    WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [
                    participantJid,
                    isDenied ? "revoked" : "rejected"
                ];
                break;
        }
    };
    const processNotification = async (node) => {
        const result = {};
        const [child] = getAllBinaryNodeChildren(node);
        const nodeType = node.attrs.type;
        const from = jidNormalizedUser(node.attrs.from);
        switch (nodeType) {
            case "privacy_token":
                const tokenList = getBinaryNodeChildren(child, "token");
                for (const { attrs, content } of tokenList) {
                    const jid = attrs.jid;
                    sock.ev.emit("chats.update", [
                        {
                            id: jid,
                            tcToken: content
                        }
                    ]);
                    config.logger.debug({ jid }, "got privacy token update");
                }
                break;
            case "w:gp2":
                handleGroupNotification(node.attrs.participant, child, result);
                break;
            case "mediaretry":
                const event = decodeMediaRetryNode(node);
                sock.ev.emit("messages.media-update", [event]);
                break;
            case "encrypt":
                await handleEncryptNotification(node);
                break;
            case "devices":
                const devices = getBinaryNodeChildren(child, "device");
                if (areJidsSameUser(child.attrs.jid, sock.authState.creds.me.id)) {
                    const deviceJids = devices.map((d) => d.attrs.jid);
                    config.logger.info({ deviceJids }, "got my own devices");
                }
                break;
            case "server_sync":
                const update = getBinaryNodeChild(node, "collection");
                if (update) {
                    const name = update.attrs.name;
                    await sock.resyncAppState([name], false);
                }
                break;
            case "picture":
                const setPicture = getBinaryNodeChild(node, "set");
                const delPicture = getBinaryNodeChild(node, "delete");
                sock.ev.emit("contacts.update", [
                    {
                        id: jidNormalizedUser(node?.attrs?.from) ||
                            (setPicture || delPicture)?.attrs?.hash ||
                            "",
                        imgUrl: setPicture ? "changed" : "removed"
                    }
                ]);
                if (isJidGroup(from)) {
                    const node = setPicture || delPicture;
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON;
                    if (setPicture) {
                        result.messageStubParameters = [setPicture.attrs.id];
                    }
                    result.participant = node?.attrs.author;
                    result.key = {
                        ...(result.key || {}),
                        participant: setPicture?.attrs.author
                    };
                }
                break;
            case "account_sync":
                if (child.tag === "disappearing_mode") {
                    const newDuration = +child.attrs.duration;
                    const timestamp = +child.attrs.t;
                    config.logger.info({ newDuration }, "updated account disappearing mode");
                    sock.ev.emit("creds.update", {
                        accountSettings: {
                            ...sock.authState.creds.accountSettings,
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp
                            }
                        }
                    });
                }
                else if (child.tag === "blocklist") {
                    const blocklists = getBinaryNodeChildren(child, "item");
                    for (const { attrs } of blocklists) {
                        const blocklist = [attrs.jid];
                        const type = attrs.action === "block" ? "add" : "remove";
                        sock.ev.emit("blocklist.update", { blocklist, type });
                    }
                }
                break;
            case "link_code_companion_reg":
                const linkCodeCompanionReg = getBinaryNodeChild(node, "link_code_companion_reg");
                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, "link_code_pairing_ref"));
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, "primary_identity_pub"));
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, "link_code_pairing_wrapped_primary_ephemeral_pub"));
                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped);
                const companionSharedKey = Curve.sharedKey(sock.authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey);
                const random = randomBytes(32);
                const linkCodeSalt = randomBytes(32);
                const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: "link_code_pairing_key_bundle_encryption_key"
                });
                const encryptPayload = Buffer.concat([
                    Buffer.from(sock.authState.creds.signedIdentityKey.public),
                    primaryIdentityPublicKey,
                    random
                ]);
                const encryptIv = randomBytes(12);
                const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0));
                const encryptedPayload = Buffer.concat([
                    linkCodeSalt,
                    encryptIv,
                    encrypted
                ]);
                const identitySharedKey = Curve.sharedKey(sock.authState.creds.signedIdentityKey.private, primaryIdentityPublicKey);
                const identityPayload = Buffer.concat([
                    companionSharedKey,
                    identitySharedKey,
                    random
                ]);
                sock.authState.creds.advSecretKey = hkdf(identityPayload, 32, {
                    info: "adv_secret"
                }).toString("base64");
                await sock.query({
                    tag: "iq",
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: "set",
                        id: sock.generateMessageTag(),
                        xmlns: "md"
                    },
                    content: [
                        {
                            tag: "link_code_companion_reg",
                            attrs: {
                                jid: sock.authState.creds.me.id,
                                stage: "companion_finish"
                            },
                            content: [
                                {
                                    tag: "link_code_pairing_wrapped_key_bundle",
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: "companion_identity_public",
                                    attrs: {},
                                    content: sock.authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: "link_code_pairing_ref",
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                });
                sock.authState.creds.registered = true;
                sock.ev.emit("creds.update", sock.authState.creds);
        }
        if (Object.keys(result).length) {
            return result;
        }
    };
    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data);
        const salt = buffer.slice(0, 32);
        const secretKey = await derivePairingCodeKey(sock.authState.creds.pairingCode, salt);
        const iv = buffer.slice(32, 48);
        const payload = buffer.slice(48, 80);
        return aesDecryptCTR(payload, secretKey, iv);
    }
    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new Boom("Invalid buffer", { statusCode: 400 });
        }
        return data instanceof Buffer ? data : Buffer.from(data);
    }
    const willSendMessageAgain = (id, participant) => {
        const key = `${id}:${participant}`;
        const retryCount = msgRetryCache.get(key) || 0;
        return retryCount < config.maxMsgRetryCount;
    };
    const updateSendMessageAgainCount = (id, participant) => {
        const key = `${id}:${participant}`;
        const newValue = (msgRetryCache.get(key) || 0) + 1;
        msgRetryCache.set(key, newValue);
    };
    const sendMessagesAgain = async (key, ids, retryNode) => {
        const msgs = await Promise.all(ids.map((id) => config.getMessage({ ...key, id })));
        const remoteJid = key.remoteJid;
        const participant = key.participant || remoteJid;
        const sendToAll = !jidDecode(participant)?.device;
        await sock.assertSessions([participant], true);
        if (isJidGroup(remoteJid)) {
            await sock.authState.keys.set({
                "sender-key-memory": { [remoteJid]: null }
            });
        }
        config.logger.debug({ participant, sendToAll }, "forced new session for retry recp");
        for (const [i, msg] of msgs.entries()) {
            if (msg) {
                updateSendMessageAgainCount(ids[i], participant);
                const msgRelayOpts = { messageId: ids[i] };
                if (sendToAll) {
                    msgRelayOpts.useUserDevicesCache = false;
                }
                else {
                    msgRelayOpts.participant = {
                        jid: participant,
                        count: +retryNode.attrs.count
                    };
                }
                await sock.relayMessage(key.remoteJid, msg, msgRelayOpts);
            }
            else {
                config.logger.debug({ jid: key.remoteJid, id: ids[i] }, "recv retry request, but message not available");
            }
        }
    };
    const handleReceipt = async (node) => {
        const { attrs, content } = node;
        const isLid = /lid$/.test(attrs.from);
        const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? sock.authState.creds.me?.lid : sock.authState.creds.me?.id);
        const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        const fromMe = !attrs.recipient || (attrs.type === "retry" && isNodeFromMe);
        const key = {
            remoteJid,
            id: "",
            fromMe,
            participant: attrs.participant
        };
        if (config.shouldIgnoreJid(remoteJid) && remoteJid !== "@s.whatsapp.net") {
            config.logger.debug({ remoteJid }, "ignoring receipt from jid");
            await sendMessageAck(node);
            return;
        }
        const ids = [attrs.id];
        if (Array.isArray(content)) {
            const items = getBinaryNodeChildren(content[0], "item");
            ids.push(...items.map((i) => i.attrs.id));
        }
        try {
            await Promise.all([
                sock.processingMutex.mutex(async () => {
                    const status = getStatusFromReceiptType(attrs.type);
                    if (typeof status !== "undefined" &&
                        (status > proto.WebMessageInfo.Status.DELIVERY_ACK || !isNodeFromMe)) {
                        if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
                            if (attrs.participant) {
                                const updateKey = status === proto.WebMessageInfo.Status.DELIVERY_ACK
                                    ? "receiptTimestamp"
                                    : "readTimestamp";
                                sock.ev.emit("message-receipt.update", ids.map((id) => ({
                                    key: { ...key, id },
                                    receipt: {
                                        userJid: jidNormalizedUser(attrs.participant),
                                        [updateKey]: +attrs.t
                                    }
                                })));
                            }
                        }
                        else {
                            sock.ev.emit("messages.update", ids.map((id) => ({
                                key: { ...key, id },
                                update: { status }
                            })));
                        }
                    }
                    if (attrs.type === "retry") {
                        key.participant = key.participant || attrs.from;
                        const retryNode = getBinaryNodeChild(node, "retry");
                        if (willSendMessageAgain(ids[0], key.participant)) {
                            if (key.fromMe) {
                                try {
                                    config.logger.debug({ attrs, key }, "recv retry request");
                                    await sendMessagesAgain(key, ids, retryNode);
                                }
                                catch (error) {
                                    config.logger.error({ key, ids, trace: error.stack }, "error in sending message again");
                                }
                            }
                            else {
                                config.logger.info({ attrs, key }, "recv retry for not fromMe message");
                            }
                        }
                        else {
                            config.logger.info({ attrs, key }, "will not send message again, as sent too many times");
                        }
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node);
        }
    };
    const handleNotification = async (node) => {
        const remoteJid = node.attrs.from;
        if (config.shouldIgnoreJid(remoteJid) && remoteJid !== "@s.whatsapp.net") {
            config.logger.debug({ remoteJid, id: node.attrs.id }, "ignored notification");
            await sendMessageAck(node);
            return;
        }
        try {
            await Promise.all([
                sock.processingMutex.mutex(async () => {
                    const msg = await processNotification(node);
                    if (msg) {
                        const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, sock.authState.creds.me.id);
                        msg.key = {
                            remoteJid,
                            fromMe,
                            participant: node.attrs.participant,
                            id: node.attrs.id,
                            ...(msg.key || {})
                        };
                        msg.participant ??= node.attrs.participant;
                        msg.messageTimestamp = +node.attrs.t;
                        const fullMsg = proto.WebMessageInfo.fromObject(msg);
                        await sock.upsertMessage(fullMsg, "append");
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node);
        }
    };
    const handleMessage = async (node) => {
        if (config.shouldIgnoreJid(node.attrs.from) &&
            node.attrs.from !== "@s.whatsapp.net") {
            config.logger.debug({ key: node.attrs.key }, "ignored message");
            await sendMessageAck(node);
            return;
        }
        let response;
        if (getBinaryNodeChild(node, "unavailable") &&
            !getBinaryNodeChild(node, "enc")) {
            await sendMessageAck(node);
            const { key } = decodeMessageNode(node, sock.authState.creds.me.id, sock.authState.creds.me.lid || "").fullMessage;
            response = await requestPlaceholderResend(key);
            if (response === "RESOLVED") {
                return;
            }
            config.logger.debug("received unavailable message, acked and requested resend from phone");
        }
        else {
            if (placeholderResendCache.get(node.attrs.id)) {
                placeholderResendCache.del(node.attrs.id);
            }
        }
        const { fullMessage: msg, category, author, decrypt } = decryptMessageNode(node, sock.authState.creds.me.id, sock.authState.creds.me.lid || "", sock.signalRepository, config.logger);
        if (response &&
            msg?.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
            msg.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT, response];
        }
        if (msg.message?.protocolMessage?.type ===
            proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER &&
            node.attrs.sender_pn) {
            sock.ev.emit("chats.phoneNumberShare", {
                lid: node.attrs.from,
                jid: node.attrs.sender_pn
            });
        }
        try {
            await Promise.all([
                sock.processingMutex.mutex(async () => {
                    await decrypt();
                    if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
                        if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
                            return sendMessageAck(node, NACK_REASONS.ParsingError);
                        }
                        retryMutex.mutex(async () => {
                            if (sock.ws.isOpen) {
                                if (getBinaryNodeChild(node, "unavailable")) {
                                    return;
                                }
                                const encNode = getBinaryNodeChild(node, "enc");
                                await sendRetryRequest(node, !encNode);
                                if (config.retryRequestDelayMs) {
                                    await delay(config.retryRequestDelayMs);
                                }
                            }
                            else {
                                config.logger.debug({ node }, "connection closed, ignoring retry req");
                            }
                        });
                    }
                    else {
                        let type = undefined;
                        let participant = msg.key.participant;
                        if (category === "peer") {
                            type = "peer_msg";
                        }
                        else if (msg.key.fromMe) {
                            type = "sender";
                            if (isJidUser(msg.key.remoteJid)) {
                                participant = author;
                            }
                        }
                        else if (!sendActiveReceipts) {
                            type = "inactive";
                        }
                        await sock.sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);
                        const isAnyHistoryMsg = getHistoryMsg(msg.message);
                        if (isAnyHistoryMsg) {
                            const jid = jidNormalizedUser(msg.key.remoteJid);
                            await sock.sendReceipt(jid, undefined, [msg.key.id], "hist_sync");
                        }
                    }
                    cleanMessage(msg, sock.authState.creds.me.id);
                    await sendMessageAck(node);
                    await sock.upsertMessage(msg, node.attrs.offline ? "append" : "notify");
                })
            ]);
        }
        catch (error) {
            config.logger.error({ error, node }, "error in handling message");
        }
    };
    const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
        if (!sock.authState.creds.me?.id) {
            throw new Boom("Not authenticated");
        }
        const pdoMessage = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
        };
        return sock.sendPeerDataOperationMessage(pdoMessage);
    };
    const requestPlaceholderResend = async (messageKey) => {
        if (!sock.authState.creds.me?.id) {
            throw new Boom("Not authenticated");
        }
        if (placeholderResendCache.get(messageKey?.id)) {
            config.logger.debug("already requested resend", { messageKey });
            return;
        }
        else {
            placeholderResendCache.set(messageKey?.id, true);
        }
        await delay(5000);
        if (!placeholderResendCache.get(messageKey?.id)) {
            config.logger.debug("message received while resend requested", {
                messageKey
            });
            return "RESOLVED";
        }
        const pdoMessage = {
            placeholderMessageResendRequest: [
                {
                    messageKey
                }
            ],
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
        };
        setTimeout(() => {
            if (placeholderResendCache.get(messageKey?.id)) {
                config.logger.debug("PDO message without response after 15 seconds. Phone possibly offline", { messageKey });
                placeholderResendCache.del(messageKey?.id);
            }
        }, 15_000);
        return sock.sendPeerDataOperationMessage(pdoMessage);
    };
    const handleCall = async (node) => {
        const { attrs } = node;
        const [infoChild] = getAllBinaryNodeChildren(node);
        const callId = infoChild.attrs["call-id"];
        const from = infoChild.attrs.from || infoChild.attrs["call-creator"];
        const status = getCallStatusFromNode(infoChild);
        const call = {
            chatId: attrs.from,
            from,
            id: callId,
            date: new Date(+attrs.t * 1000),
            offline: !!attrs.offline,
            status
        };
        if (status === "offer") {
            call.isVideo = !!getBinaryNodeChild(infoChild, "video");
            call.isGroup =
                infoChild.attrs.type === "group" || !!infoChild.attrs["group-jid"];
            call.groupJid = infoChild.attrs["group-jid"];
            callOfferCache.set(call.id, call);
        }
        const existingCall = callOfferCache.get(call.id);
        if (existingCall) {
            call.isVideo = existingCall.isVideo;
            call.isGroup = existingCall.isGroup;
        }
        if (status === "reject" ||
            status === "accept" ||
            status === "timeout" ||
            status === "terminate") {
            callOfferCache.del(call.id);
        }
        sock.ev.emit("call", [call]);
        await sendMessageAck(node);
    };
    const handleBadAck = async ({ attrs }) => {
        const key = {
            remoteJid: attrs.from,
            fromMe: true,
            id: attrs.id
        };
        if (attrs.error) {
            config.logger.warn({ attrs }, "received error in ack");
            sock.ev.emit("messages.update", [
                {
                    key,
                    update: {
                        status: WAMessageStatus.ERROR,
                        messageStubParameters: [attrs.error]
                    }
                }
            ]);
        }
    };
    const processNodeWithBuffer = async (node, identifier, exec) => {
        sock.ev.buffer();
        await execTask();
        sock.ev.flush();
        function execTask() {
            return exec(node, false).catch((err) => sock.onUnexpectedError(err, identifier));
        }
    };
    const makeOfflineNodeProcessor = () => {
        const nodeProcessorMap = new Map([
            ["message", handleMessage],
            ["call", handleCall],
            ["receipt", handleReceipt],
            ["notification", handleNotification]
        ]);
        const nodes = [];
        let isProcessing = false;
        const enqueue = (type, node) => {
            nodes.push({ type, node });
            if (isProcessing) {
                return;
            }
            isProcessing = true;
            const promise = async () => {
                while (nodes.length && sock.ws.isOpen) {
                    const { type, node } = nodes.shift();
                    const nodeProcessor = nodeProcessorMap.get(type);
                    if (!nodeProcessor) {
                        sock.onUnexpectedError(new Error(`unknown offline node type: ${type}`), "processing offline node");
                        continue;
                    }
                    await nodeProcessor(node);
                }
                isProcessing = false;
            };
            promise().catch((error) => sock.onUnexpectedError(error, "processing offline nodes"));
        };
        return { enqueue };
    };
    const offlineNodeProcessor = makeOfflineNodeProcessor();
    const processNode = (type, node, identifier, exec) => {
        const isOffline = !!node.attrs.offline;
        if (isOffline) {
            offlineNodeProcessor.enqueue(type, node);
        }
        else {
            processNodeWithBuffer(node, identifier, exec);
        }
    };
    sock.ws.on("CB:message", (node) => {
        processNode("message", node, "processing message", handleMessage);
    });
    sock.ws.on("CB:call", async (node) => {
        processNode("call", node, "handling call", handleCall);
    });
    sock.ws.on("CB:receipt", (node) => {
        processNode("receipt", node, "handling receipt", handleReceipt);
    });
    sock.ws.on("CB:notification", async (node) => {
        processNode("notification", node, "handling notification", handleNotification);
    });
    sock.ws.on("CB:ack,class:message", (node) => {
        handleBadAck(node).catch((error) => sock.onUnexpectedError(error, "handling bad ack"));
    });
    sock.ev.on("call", ([call]) => {
        if (call.status === "timeout" ||
            (call.status === "offer" && call.isGroup)) {
            const msg = {
                key: {
                    remoteJid: call.chatId,
                    id: call.id,
                    fromMe: false
                },
                messageTimestamp: unixTimestampSeconds(call.date)
            };
            if (call.status === "timeout") {
                if (call.isGroup) {
                    msg.messageStubType = call.isVideo
                        ? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
                        : WAMessageStubType.CALL_MISSED_GROUP_VOICE;
                }
                else {
                    msg.messageStubType = call.isVideo
                        ? WAMessageStubType.CALL_MISSED_VIDEO
                        : WAMessageStubType.CALL_MISSED_VOICE;
                }
            }
            else {
                msg.message = { call: { callKey: Buffer.from(call.id) } };
            }
            const protoMsg = proto.WebMessageInfo.fromObject(msg);
            sock.upsertMessage(protoMsg, call.offline ? "append" : "notify");
        }
    });
    sock.ev.on("connection.update", ({ isOnline }) => {
        if (typeof isOnline !== "undefined") {
            sendActiveReceipts = isOnline;
            config.logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`);
        }
    });
    return {
        ...sock,
        sendMessageAck,
        sendRetryRequest,
        rejectCall,
        fetchMessageHistory,
        requestPlaceholderResend
    };
};
