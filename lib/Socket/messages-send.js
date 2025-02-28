import { Boom } from "@hapi/boom";
import NodeCache from "@cacheable/node-cache";
import { proto } from "../../WAProto/index.js";
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from "../Defaults/index.js";
import { aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateMessageIDV2, generateWAMessage, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, normalizeMessageContent, parseAndInjectE2ESessions, unixTimestampSeconds } from "../Utils/index.js";
import { getUrlInfo } from "../Utils/link-preview.js";
import { areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET } from "../WABinary/index.js";
import { USyncQuery, USyncUser } from "../WAUSync/index.js";
import { makeGroupsSocket } from "./groups.js";
export const makeMessagesSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const userDevicesCache = config.userDevicesCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
            useClones: false
        });
    let mediaConn;
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn;
        if (!media ||
            forceGet ||
            Date.now() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await sock.query({
                    tag: "iq",
                    attrs: {
                        type: "set",
                        xmlns: "w:m",
                        to: S_WHATSAPP_NET
                    },
                    content: [{ tag: "media_conn", attrs: {} }]
                });
                const mediaConnNode = getBinaryNodeChild(result, "media_conn");
                const node = {
                    hosts: getBinaryNodeChildren(mediaConnNode, "host").map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                config.logger.debug("fetched media conn");
                return node;
            })();
        }
        return mediaConn;
    };
    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: "receipt",
            attrs: {
                id: messageIds[0]
            }
        };
        const isReadReceipt = type === "read" || type === "read-self";
        if (isReadReceipt) {
            node.attrs.t = unixTimestampSeconds().toString();
        }
        if (type === "sender" && isJidUser(jid)) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: "list",
                    attrs: {},
                    content: remainingMessageIds.map((id) => ({
                        tag: "item",
                        attrs: { id }
                    }))
                }
            ];
        }
        config.logger.debug({ attrs: node.attrs, messageIds }, "sending receipt for messages");
        await sock.sendNode(node);
    };
    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    const readMessages = async (keys) => {
        const privacySettings = await sock.fetchPrivacySettings();
        const readType = privacySettings.readreceipts === "all" ? "read" : "read-self";
        await sendReceipts(keys, readType);
    };
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = [];
        if (!useCache) {
            config.logger.debug("not using cache for devices");
        }
        const toFetch = [];
        jids = Array.from(new Set(jids));
        for (let jid of jids) {
            const user = jidDecode(jid)?.user;
            jid = jidNormalizedUser(jid);
            if (useCache) {
                const devices = userDevicesCache.get(user);
                if (devices) {
                    deviceResults.push(...devices);
                    config.logger.trace({ user }, "using cache for devices");
                }
                else {
                    toFetch.push(jid);
                }
            }
            else {
                toFetch.push(jid);
            }
        }
        if (!toFetch.length) {
            return deviceResults;
        }
        const query = new USyncQuery().withContext("message").withDeviceProtocol();
        for (const jid of toFetch) {
            query.withUser(new USyncUser().withId(jid));
        }
        const result = await sock.executeUSyncQuery(query);
        if (result) {
            const extracted = extractDeviceJids(result?.list, sock.authState.creds.me.id, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user].push(item);
                deviceResults.push(item);
            }
            for (const key in deviceMap) {
                userDevicesCache.set(key, deviceMap[key]);
            }
        }
        return deviceResults;
    };
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        let jidsRequiringFetch = [];
        if (force) {
            jidsRequiringFetch = jids;
        }
        else {
            const addrs = jids.map((jid) => sock.signalRepository.jidToSignalProtocolAddress(jid));
            const sessions = await sock.authState.keys.get("session", addrs);
            for (const jid of jids) {
                const signalId = sock.signalRepository.jidToSignalProtocolAddress(jid);
                if (!sessions[signalId]) {
                    jidsRequiringFetch.push(jid);
                }
            }
        }
        if (jidsRequiringFetch.length) {
            config.logger.debug({ jidsRequiringFetch }, "fetching sessions");
            const result = await sock.query({
                tag: "iq",
                attrs: {
                    xmlns: "encrypt",
                    type: "get",
                    to: S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: "key",
                        attrs: {},
                        content: jidsRequiringFetch.map((jid) => ({
                            tag: "user",
                            attrs: { jid }
                        }))
                    }
                ]
            });
            await parseAndInjectE2ESessions(result, sock.signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!sock.authState.creds.me?.id) {
            throw new Boom("Not authenticated");
        }
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type
                    .PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        return await relayMessage(jidNormalizedUser(sock.authState.creds.me.id), protocolMessage, {
            additionalAttributes: {
                category: "peer",
                push_priority: "high_force"
            }
        });
    };
    const createParticipantNodes = async (jids, message, extraAttrs) => {
        const patched = await config.patchMessageBeforeSending(message, jids);
        const bytes = encodeWAMessage(patched);
        let shouldIncludeDeviceIdentity = false;
        const nodes = await Promise.all(jids.map(async (jid) => {
            const { type, ciphertext } = await sock.signalRepository.encryptMessage({
                jid,
                data: bytes
            });
            if (type === "pkmsg") {
                shouldIncludeDeviceIdentity = true;
            }
            const node = {
                tag: "to",
                attrs: { jid },
                content: [
                    {
                        tag: "enc",
                        attrs: {
                            v: "2",
                            type,
                            ...(extraAttrs || {})
                        },
                        content: ciphertext
                    }
                ]
            };
            return node;
        }));
        return { nodes, shouldIncludeDeviceIdentity };
    };
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {
        const meId = sock.authState.creds.me.id;
        let shouldIncludeDeviceIdentity = false;
        const { user, server } = jidDecode(jid);
        const statusJid = "status@broadcast";
        const isGroup = server === "g.us";
        const isStatus = jid === statusJid;
        const isLid = server === "lid";
        const isNewsletter = server === "newsletter";
        msgId = msgId || generateMessageIDV2(sock.user?.id);
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus;
        const participants = [];
        const destinationJid = !isStatus
            ? jidEncode(user, isLid
                ? "lid"
                : isGroup
                    ? "g.us"
                    : isNewsletter
                        ? "newsletter"
                        : "s.whatsapp.net")
            : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            }
        };
        const extraAttrs = {};
        if (participant) {
            if (!isGroup && !isStatus) {
                additionalAttributes = {
                    ...additionalAttributes,
                    device_fanout: "false"
                };
            }
            const { user, device } = jidDecode(participant.jid);
            devices.push({ user, device });
        }
        await sock.authState.keys.transaction(async () => {
            const mediaType = getMediaType(message);
            if (mediaType) {
                extraAttrs["mediatype"] = mediaType;
            }
            if (normalizeMessageContent(message)?.pinInChatMessage) {
                extraAttrs["decrypt-fail"] = "hide";
            }
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && config.cachedGroupMetadata
                            ? await config.cachedGroupMetadata(jid)
                            : undefined;
                        if (groupData && Array.isArray(groupData?.participants)) {
                            config.logger.trace({ jid, participants: groupData.participants.length }, "using cached group metadata");
                        }
                        else if (!isStatus) {
                            groupData = await sock.groupMetadata(jid);
                        }
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await sock.authState.keys.get("sender-key-memory", [jid]);
                            return result[jid] || {};
                        }
                        return {};
                    })()
                ]);
                if (!participant) {
                    const participantsList = groupData && !isStatus
                        ? groupData.participants.map((p) => p.id)
                        : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const patched = await config.patchMessageBeforeSending(message, devices.map((d) => jidEncode(d.user, isLid ? "lid" : "s.whatsapp.net", d.device)));
                const bytes = encodeWAMessage(patched);
                const { ciphertext, senderKeyDistributionMessage } = await sock.signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId
                });
                const senderKeyJids = [];
                for (const { user, device } of devices) {
                    const jid = jidEncode(user, isLid ? "lid" : "s.whatsapp.net", device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                        senderKeyMap[jid] = true;
                    }
                }
                if (senderKeyJids.length) {
                    config.logger.debug({ senderKeyJids }, "sending new sender key");
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    await assertSessions(senderKeyJids, false);
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs);
                    shouldIncludeDeviceIdentity =
                        shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: "enc",
                    attrs: { v: "2", type: "skmsg" },
                    content: ciphertext
                });
                await sock.authState.keys.set({
                    "sender-key-memory": { [jid]: senderKeyMap }
                });
            }
            else if (isNewsletter) {
                const bytes = proto.Message.encode(message).finish();
                binaryNodeContent.push({
                    tag: "plaintext",
                    attrs: {},
                    content: bytes
                });
            }
            else {
                const { user: meUser } = jidDecode(meId);
                if (!participant) {
                    devices.push({ user });
                    if (user !== meUser) {
                        devices.push({ user: meUser });
                    }
                    if (additionalAttributes?.["category"] !== "peer") {
                        const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                        devices.push(...additionalDevices);
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser;
                    const jid = jidEncode(isMe && isLid
                        ? sock.authState.creds?.me?.lid.split(":")[0] || user
                        : user, isLid ? "lid" : "s.whatsapp.net", device);
                    if (isMe) {
                        meJids.push(jid);
                    }
                    else {
                        otherJids.push(jid);
                    }
                    allJids.push(jid);
                }
                await assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                if (additionalAttributes?.["category"] === "peer") {
                    const peerNode = participants[0]?.content?.[0];
                    if (peerNode) {
                        binaryNodeContent.push(peerNode);
                    }
                }
                else {
                    binaryNodeContent.push({
                        tag: "participants",
                        attrs: {},
                        content: participants
                    });
                }
            }
            const stanza = {
                tag: "message",
                attrs: {
                    id: msgId,
                    type: getMessageType(message),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            };
            if (participant) {
                if (isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if (areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: "device-identity",
                    attrs: {},
                    content: encodeSignedDeviceIdentity(sock.authState.creds.account, true)
                });
                config.logger.debug({ jid }, "adding device identity");
            }
            if (additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes);
            }
            config.logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sock.sendNode(stanza);
        });
        return msgId;
    };
    const getMessageType = (message) => {
        if (message.pollCreationMessage ||
            message.pollCreationMessageV2 ||
            message.pollCreationMessageV3) {
            return "poll";
        }
        return "text";
    };
    const getMediaType = (message) => {
        if (message.imageMessage) {
            return "image";
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? "gif" : "video";
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? "ptt" : "audio";
        }
        else if (message.contactMessage) {
            return "vcard";
        }
        else if (message.documentMessage) {
            return "document";
        }
        else if (message.contactsArrayMessage) {
            return "contact_array";
        }
        else if (message.liveLocationMessage) {
            return "livelocation";
        }
        else if (message.stickerMessage) {
            return "sticker";
        }
        else if (message.listMessage) {
            return "list";
        }
        else if (message.listResponseMessage) {
            return "list_response";
        }
        else if (message.buttonsResponseMessage) {
            return "buttons_response";
        }
        else if (message.orderMessage) {
            return "order";
        }
        else if (message.productMessage) {
            return "product";
        }
        else if (message.interactiveResponseMessage) {
            return "native_flow_response";
        }
        else if (message.groupInviteMessage) {
            return "url";
        }
    };
    const getPrivacyTokens = async (jids) => {
        const t = unixTimestampSeconds().toString();
        const result = await sock.query({
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                type: "set",
                xmlns: "privacy"
            },
            content: [
                {
                    tag: "tokens",
                    attrs: {},
                    content: jids.map((jid) => ({
                        tag: "token",
                        attrs: {
                            jid: jidNormalizedUser(jid),
                            t,
                            type: "trusted_contact"
                        }
                    }))
                }
            ]
        });
        return result;
    };
    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn);
    const waitForMsgMediaUpdate = bindWaitForEvent(sock.ev, "messages.media-update");
    const updateMediaMessage = async (message) => {
        const content = assertMediaContent(message.message);
        const mediaKey = content.mediaKey;
        const meId = sock.authState.creds.me.id;
        const node = encryptMediaRetryRequest(message.key, mediaKey, meId);
        let error = undefined;
        await Promise.all([
            sock.sendNode(node),
            waitForMsgMediaUpdate((update) => {
                const result = update.find((c) => c.key.id === message.key.id);
                if (result) {
                    if (result.error) {
                        error = result.error;
                    }
                    else {
                        try {
                            const media = decryptMediaRetryData(result.media, mediaKey, result.key.id);
                            if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                const resultStr = proto.MediaRetryNotification.ResultType[media.result];
                                throw new Boom(`Media re-upload failed by device (${resultStr})`, {
                                    data: media,
                                    statusCode: getStatusCodeForMediaRetry(media.result) || 404
                                });
                            }
                            content.directPath = media.directPath;
                            content.url = getUrlFromDirectPath(content.directPath);
                            config.logger.debug({ directPath: media.directPath, key: result.key }, "media update successful");
                        }
                        catch (err) {
                            error = err;
                        }
                    }
                    return true;
                }
            })
        ]);
        if (error) {
            throw error;
        }
        sock.ev.emit("messages.update", [
            { key: message.key, update: { message: message.message } }
        ]);
        return message;
    };
    const sendMessage = async (jid, content, options = {}) => {
        const userJid = sock.authState.creds.me.id;
        if (typeof content === "object" &&
            "disappearingMessagesInChat" in content &&
            typeof content["disappearingMessagesInChat"] !== "undefined" &&
            isJidGroup(jid)) {
            const { disappearingMessagesInChat } = content;
            const value = typeof disappearingMessagesInChat === "boolean"
                ? disappearingMessagesInChat
                    ? WA_DEFAULT_EPHEMERAL
                    : 0
                : disappearingMessagesInChat;
            await sock.groupToggleEphemeral(jid, value);
        }
        else {
            const fullMsg = await generateWAMessage(jid, content, {
                logger: config.logger,
                userJid,
                getUrlInfo: (text) => getUrlInfo(text, {
                    thumbnailWidth: config.linkPreviewImageThumbnailWidth,
                    fetchOpts: {
                        timeout: 3_000,
                        ...(config.options || {})
                    },
                    logger: config.logger,
                    uploadImage: config.generateHighQualityLinkPreview
                        ? waUploadToServer
                        : undefined
                }),
                getProfilePicUrl: sock.profilePictureUrl,
                upload: waUploadToServer,
                mediaCache: config.mediaCache,
                options: config.options,
                messageId: generateMessageIDV2(sock.user?.id),
                ...options
            });
            const isDeleteMsg = "delete" in content && !!content.delete;
            const isEditMsg = "edit" in content && !!content.edit;
            const isPinMsg = "pin" in content && !!content.pin;
            const isPollMessage = "poll" in content && !!content.poll;
            const additionalAttributes = {};
            const additionalNodes = [];
            if (isDeleteMsg) {
                if (isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe) {
                    additionalAttributes.edit = "8";
                }
                else {
                    additionalAttributes.edit = "7";
                }
            }
            else if (isEditMsg) {
                additionalAttributes.edit = "1";
            }
            else if (isPinMsg) {
                additionalAttributes.edit = "2";
            }
            else if (isPollMessage) {
                additionalNodes.push({
                    tag: "meta",
                    attrs: {
                        polltype: "creation"
                    }
                });
            }
            if ("cachedGroupMetadata" in options) {
                console.warn("cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.");
            }
            await relayMessage(jid, fullMsg.message, {
                messageId: fullMsg.key.id,
                useCachedGroupMetadata: options.useCachedGroupMetadata,
                additionalAttributes,
                statusJidList: options.statusJidList,
                additionalNodes
            });
            if (config.emitOwnEvents) {
                process.nextTick(() => {
                    sock.processingMutex.mutex(() => sock.upsertMessage(fullMsg, "append"));
                });
            }
            return fullMsg;
        }
    };
    return {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        refreshMediaConn,
        waUploadToServer,
        fetchPrivacySettings: sock.fetchPrivacySettings,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        updateMediaMessage,
        sendMessage
    };
};
