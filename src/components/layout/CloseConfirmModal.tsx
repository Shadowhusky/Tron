import Modal from "../ui/Modal";
import type { ResolvedTheme } from "../../contexts/ThemeContext";

interface CloseConfirmModalProps {
    show: boolean;
    resolvedTheme: ResolvedTheme;
    onAction: (action: "save" | "discard" | "cancel") => void;
}

const CloseConfirmModal: React.FC<CloseConfirmModalProps> = ({ show, resolvedTheme, onAction }) => (
    <Modal
        show={show}
        resolvedTheme={resolvedTheme}
        onClose={() => onAction("cancel")}
        title="Close Tron?"
        description="You have active terminal sessions."
        maxWidth="max-w-md"
        testId="close-confirm-modal"
        zIndex="z-[100]"
        buttons={[
            { label: "Cancel", type: "ghost", onClick: () => onAction("cancel"), testId: "close-confirm-cancel" },
            { label: "Exit Without Saving", type: "default", onClick: () => onAction("discard"), testId: "close-confirm-discard" },
            { label: "Exit & Save", type: "primary", onClick: () => onAction("save"), testId: "close-confirm-save" },
        ]}
    />
);

export default CloseConfirmModal;
