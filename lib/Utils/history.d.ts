import { AxiosRequestConfig } from "axios";
import { proto } from "../../WAProto/index.js";
import { Chat, Contact } from "../Types";
export declare const downloadHistory: (msg: proto.Message.IHistorySyncNotification, options: AxiosRequestConfig<{}>) => Promise<proto.HistorySync>;
export declare const processHistoryMessage: (item: proto.IHistorySync) => {
    chats: Chat[];
    contacts: Contact[];
    messages: proto.IWebMessageInfo[];
    syncType: proto.HistorySync.HistorySyncType;
    progress: number;
};
export declare const downloadAndProcessHistorySyncNotification: (msg: proto.Message.IHistorySyncNotification, options: AxiosRequestConfig<{}>) => Promise<{
    chats: Chat[];
    contacts: Contact[];
    messages: proto.IWebMessageInfo[];
    syncType: proto.HistorySync.HistorySyncType;
    progress: number;
}>;
export declare const getHistoryMsg: (message: proto.IMessage) => proto.Message.IHistorySyncNotification;
