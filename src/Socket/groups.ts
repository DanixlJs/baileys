import { proto } from "../../WAProto/index.js";
import {
  GroupMetadata,
  GroupParticipant,
  ParticipantAction,
  SocketConfig,
  WAMessageKey,
  WAMessageStubType
} from "../Types";
import {
  generateMessageID,
  generateMessageIDV2,
  unixTimestampSeconds
} from "../Utils/index.js";
import {
  BinaryNode,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  getBinaryNodeChildString,
  jidEncode,
  jidNormalizedUser
} from "../WABinary/index.js";
import { makeChatsSocket } from "./chats.js";

export const makeGroupsSocket = (config: SocketConfig) => {
  const sock = makeChatsSocket(config);

  const groupQuery = async (
    jid: string,
    type: "get" | "set",
    content: BinaryNode[]
  ) =>
    sock.query({
      tag: "iq",
      attrs: {
        type,
        xmlns: "w:g2",
        to: jid
      },
      content
    });

  const groupMetadata = async (jid: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(jid, "get", [
      { tag: "query", attrs: { request: "interactive" } }
    ]);
    return extractGroupMetadata(result);
  };

  const groupFetchAllParticipating = async () => {
    const result = await sock.query({
      tag: "iq",
      attrs: {
        to: "@g.us",
        xmlns: "w:g2",
        type: "get"
      },
      content: [
        {
          tag: "participating",
          attrs: {},
          content: [
            { tag: "participants", attrs: {} },
            { tag: "description", attrs: {} }
          ]
        }
      ]
    });
    const data: { [_: string]: GroupMetadata } = {};
    const groupsChild = getBinaryNodeChild(result, "groups");
    if (groupsChild) {
      const groups = getBinaryNodeChildren(groupsChild, "group");
      for (const groupNode of groups) {
        const meta = extractGroupMetadata({
          tag: "result",
          attrs: {},
          content: [groupNode]
        });
        data[meta.id] = meta;
      }
    }
    sock.ev.emit("groups.update", Object.values(data));
    return data;
  };
  sock.ws.on("CB:ib,,dirty", async (node: BinaryNode) => {
    const { attrs } = getBinaryNodeChild(node, "dirty")!;
    if (attrs.type !== "groups") {
      return;
    }
    await groupFetchAllParticipating();
    await sock.cleanDirtyBits("groups");
  });

  const groupCreate = async (subject: string, participants: string[]) => {
    const key = generateMessageID();
    const result = await groupQuery("@g.us", "set", [
      {
        tag: "create",
        attrs: {
          subject,
          key
        },
        content: participants.map((jid) => ({
          tag: "participant",
          attrs: { jid }
        }))
      }
    ]);
    return extractGroupMetadata(result);
  };

  const groupLeave = async (jid: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    await groupQuery("@g.us", "set", [
      {
        tag: "leave",
        attrs: {},
        content: [{ tag: "group", attrs: { id: jid } }]
      }
    ]);
  };

  const groupUpdateSubject = async (jid: string, subject: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    await groupQuery(jid, "set", [
      {
        tag: "subject",
        attrs: {},
        content: Buffer.from(subject, "utf-8")
      }
    ]);
  };

  const groupRequestParticipantsList = async (jid: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(jid, "get", [
      {
        tag: "membership_approval_requests",
        attrs: {}
      }
    ]);
    const node = getBinaryNodeChild(result, "membership_approval_requests");
    const participants = getBinaryNodeChildren(
      node,
      "membership_approval_request"
    );
    return participants.map((v) => v.attrs);
  };

  const groupRequestParticipantsUpdate = async (
    jid: string,
    participants: string[],
    action: "approve" | "reject"
  ) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(jid, "set", [
      {
        tag: "membership_requests_action",
        attrs: {},
        content: [
          {
            tag: action,
            attrs: {},
            content: participants.map((jid) => ({
              tag: "participant",
              attrs: { jid }
            }))
          }
        ]
      }
    ]);
    const node = getBinaryNodeChild(result, "membership_requests_action");
    const nodeAction = getBinaryNodeChild(node, action);
    const participantsAffected = getBinaryNodeChildren(
      nodeAction,
      "participant"
    );
    return participantsAffected.map((p) => {
      return { status: p.attrs.error || "200", jid: p.attrs.jid };
    });
  };

  const groupParticipantsUpdate = async (
    jid: string,
    participants: string[],
    action: ParticipantAction
  ) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(jid, "set", [
      {
        tag: action,
        attrs: {},
        content: participants.map((jid) => ({
          tag: "participant",
          attrs: { jid }
        }))
      }
    ]);
    const node = getBinaryNodeChild(result, action);
    const participantsAffected = getBinaryNodeChildren(node, "participant");
    return participantsAffected.map((p) => {
      return { status: p.attrs.error || "200", jid: p.attrs.jid, content: p };
    });
  };

  const groupUpdateDescription = async (jid: string, description?: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const metadata = await groupMetadata(jid);
    const prev = metadata.descId ?? null;
    await groupQuery(jid, "set", [
      {
        tag: "description",
        attrs: {
          ...(description ? { id: generateMessageID() } : { delete: "true" }),
          ...(prev ? { prev } : {})
        },
        content: description
          ? [
              {
                tag: "body",
                attrs: {},
                content: Buffer.from(description, "utf-8")
              }
            ]
          : undefined
      }
    ]);
  };

  const groupInviteCode = async (jid: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(jid, "get", [{ tag: "invite", attrs: {} }]);
    const inviteNode = getBinaryNodeChild(result, "invite");
    return inviteNode?.attrs.code;
  };

  const groupInviteLink = async (jid: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const code = await groupInviteCode(jid);
    if (code) {
      return `https://chat.whatsapp.com/${code}`;
    }
    return "Could not get invitation link";
  };

  const groupRevokeInvite = async (jid: string) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(jid, "set", [{ tag: "invite", attrs: {} }]);
    const inviteNode = getBinaryNodeChild(result, "invite");
    return inviteNode?.attrs.code;
  };

  const groupAcceptInvite = async (code: string) => {
    const results = await groupQuery("@g.us", "set", [
      { tag: "invite", attrs: { code } }
    ]);
    const result = getBinaryNodeChild(results, "group");
    return result?.attrs.jid;
  };

  const groupRevokeInviteV4 = async (groupJid: string, invitedJid: string) => {
    if (!groupJid || !/^\d+@g\.us$/.test(groupJid)) {
      throw new Error(
        `The entered jid '${groupJid}' is invalid, please enter a group jid to continue`
      );
    }
    const result = await groupQuery(groupJid, "set", [
      {
        tag: "revoke",
        attrs: {},
        content: [{ tag: "participant", attrs: { jid: invitedJid } }]
      }
    ]);
    return !!result;
  };

  const groupAcceptInviteV4 = sock.ev.createBufferedFunction(
    async (
      key: string | WAMessageKey,
      inviteMessage: proto.Message.IGroupInviteMessage
    ) => {
      key = typeof key === "string" ? { remoteJid: key } : key;
      const results = await groupQuery(inviteMessage.groupJid, "set", [
        {
          tag: "accept",
          attrs: {
            code: inviteMessage.inviteCode,
            expiration: inviteMessage.inviteExpiration.toString(),
            admin: key.remoteJid
          }
        }
      ]);
      if (key.id) {
        inviteMessage =
          proto.Message.GroupInviteMessage.fromObject(inviteMessage);
        inviteMessage.inviteExpiration = 0;
        inviteMessage.inviteCode = "";
        sock.ev.emit("messages.update", [
          {
            key,
            update: {
              message: {
                groupInviteMessage: inviteMessage
              }
            }
          }
        ]);
      }
      await sock.upsertMessage(
        {
          key: {
            remoteJid: inviteMessage.groupJid,
            id: generateMessageIDV2(sock.user?.id),
            fromMe: false,
            participant: key.remoteJid
          },
          messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
          messageStubParameters: [sock.authState.creds.me.id],
          participant: key.remoteJid,
          messageTimestamp: unixTimestampSeconds()
        },
        "notify"
      );
      return results.attrs.from;
    }
  );

  const groupGetInviteInfo = async (code: string) => {
    const results = await groupQuery("@g.us", "get", [
      { tag: "invite", attrs: { code } }
    ]);
    return extractGroupMetadata(results);
  };

  const groupToggleEphemeral = async (
    jid: string,
    ephemeralExpiration: number
  ) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    const content: BinaryNode = ephemeralExpiration
      ? {
          tag: "ephemeral",
          attrs: { expiration: ephemeralExpiration.toString() }
        }
      : { tag: "not_ephemeral", attrs: {} };
    await groupQuery(jid, "set", [content]);
  };

  const groupSettingUpdate = async (
    jid: string,
    setting: "announcement" | "not_announcement" | "locked" | "unlocked"
  ) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    await groupQuery(jid, "set", [{ tag: setting, attrs: {} }]);
  };

  const groupMemberAddMode = async (
    jid: string,
    mode: "admin_add" | "all_member_add"
  ) => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    await groupQuery(jid, "set", [
      { tag: "member_add_mode", attrs: {}, content: mode }
    ]);
  };

  const groupJoinApprovalMode = async (jid: string, mode: "on" | "off") => {
    if (!jid || !/^\d+@g\.us$/.test(jid)) {
      throw new Error(
        `The entered jid '${jid}' is invalid, please enter a group jid to continue`
      );
    }
    await groupQuery(jid, "set", [
      {
        tag: "membership_approval_mode",
        attrs: {},
        content: [{ tag: "group_join", attrs: { state: mode } }]
      }
    ]);
  };

  return {
    ...sock,
    groupMetadata,
    groupCreate,
    groupLeave,
    groupUpdateSubject,
    groupRequestParticipantsList,
    groupRequestParticipantsUpdate,
    groupParticipantsUpdate,
    groupUpdateDescription,
    groupInviteCode,
    groupInviteLink,
    groupRevokeInvite,
    groupAcceptInvite,
    groupRevokeInviteV4,
    groupAcceptInviteV4,
    groupGetInviteInfo,
    groupToggleEphemeral,
    groupSettingUpdate,
    groupMemberAddMode,
    groupJoinApprovalMode,
    groupFetchAllParticipating
  };
};

export const extractGroupMetadata = (result: BinaryNode) => {
  const group = getBinaryNodeChild(result, "group");
  const descChild = getBinaryNodeChild(group, "description");
  let desc: string | undefined;
  let descId: string | undefined;
  if (descChild) {
    desc = getBinaryNodeChildString(descChild, "body");
    descId = descChild.attrs.id;
  }
  const groupId = group.attrs.id.includes("@")
    ? group.attrs.id
    : jidEncode(group.attrs.id, "g.us");
  const eph = getBinaryNodeChild(group, "ephemeral")?.attrs.expiration;
  const memberAddMode =
    getBinaryNodeChildString(group, "member_add_mode") === "all_member_add";
  const metadata: GroupMetadata = {
    id: groupId,
    subject: group.attrs.subject,
    subjectOwner: group.attrs.s_o,
    subjectTime: +group.attrs.s_t,
    size: getBinaryNodeChildren(group, "participant").length,
    creation: +group.attrs.creation,
    owner: group.attrs.creator
      ? jidNormalizedUser(group.attrs.creator)
      : undefined,
    desc,
    descId,
    linkedParent:
      getBinaryNodeChild(group, "linked_parent")?.attrs.jid || undefined,
    restrict: !!getBinaryNodeChild(group, "locked"),
    announce: !!getBinaryNodeChild(group, "announcement"),
    isCommunity: !!getBinaryNodeChild(group, "parent"),
    isCommunityAnnounce: !!getBinaryNodeChild(group, "default_sub_group"),
    joinApprovalMode: !!getBinaryNodeChild(group, "membership_approval_mode"),
    memberAddMode,
    participants: getBinaryNodeChildren(group, "participant").map(
      ({ attrs }) => {
        return {
          id: attrs.jid,
          admin: (attrs.type || null) as GroupParticipant["admin"]
        };
      }
    ),
    ephemeralDuration: eph ? +eph : undefined
  };
  return metadata;
};
