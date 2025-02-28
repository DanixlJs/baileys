import { assertNodeErrorFree } from "../../WABinary/index.js";
export class USyncStatusProtocol {
    name = "status";
    getQueryElement() {
        return {
            tag: "status",
            attrs: {}
        };
    }
    getUserElement() {
        return null;
    }
    parser(node) {
        if (node.tag === "status") {
            assertNodeErrorFree(node);
            let status = node?.content.toString();
            const setAt = new Date(+(node?.attrs.t || 0) * 1000);
            if (!status) {
                if (+node.attrs?.code === 401) {
                    status = "";
                }
                else {
                    status = null;
                }
            }
            else if (typeof status === "string" && status.length === 0) {
                status = null;
            }
            return {
                status,
                setAt
            };
        }
    }
}
