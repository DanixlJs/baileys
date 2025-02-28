import { assertNodeErrorFree } from "../../WABinary/index.js";
export class USyncDisappearingModeProtocol {
    name = "disappearing_mode";
    getQueryElement() {
        return {
            tag: "disappearing_mode",
            attrs: {}
        };
    }
    getUserElement() {
        return null;
    }
    parser(node) {
        if (node.tag === "status") {
            assertNodeErrorFree(node);
            const duration = +node?.attrs.duration;
            const setAt = new Date(+(node?.attrs.t || 0) * 1000);
            return {
                duration,
                setAt
            };
        }
    }
}
