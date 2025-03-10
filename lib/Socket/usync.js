import { Boom } from "@hapi/boom";
import { S_WHATSAPP_NET } from "../WABinary";
import { makeSocket } from "./socket";
export const makeUSyncSocket = (config) => {
    const sock = makeSocket(config);
    const executeUSyncQuery = async (usyncQuery) => {
        if (usyncQuery.protocols.length === 0) {
            throw new Boom("USyncQuery must have at least one protocol");
        }
        const validUsers = usyncQuery.users;
        const userNodes = validUsers.map((user) => {
            return {
                tag: "user",
                attrs: {
                    jid: !user.phone ? user.id : undefined
                },
                content: usyncQuery.protocols
                    .map((a) => a.getUserElement(user))
                    .filter((a) => a !== null)
            };
        });
        const listNode = {
            tag: "list",
            attrs: {},
            content: userNodes
        };
        const queryNode = {
            tag: "query",
            attrs: {},
            content: usyncQuery.protocols.map((a) => a.getQueryElement())
        };
        const iq = {
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                type: "get",
                xmlns: "usync"
            },
            content: [
                {
                    tag: "usync",
                    attrs: {
                        context: usyncQuery.context,
                        mode: usyncQuery.mode,
                        sid: sock.generateMessageTag(),
                        last: "true",
                        index: "0"
                    },
                    content: [queryNode, listNode]
                }
            ]
        };
        const result = await sock.query(iq);
        return usyncQuery.parseUSyncQueryResult(result);
    };
    return {
        ...sock,
        executeUSyncQuery
    };
};
