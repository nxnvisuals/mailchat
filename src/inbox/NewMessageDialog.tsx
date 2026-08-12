// NewMessageDialog — start a brand-new email conversation with the same
// casual-note → polished-email flow as replies.

import { X } from "lucide-react";
import Composer from "./Composer";
import type { Provider } from "./api";

interface NewMessageDialogProps {
  accountId: string;
  provider: Provider;
  aiEnabled: boolean;
  onClose: () => void;
  onSent: () => void;
}

export default function NewMessageDialog({ accountId, provider, aiEnabled, onClose, onSent }: NewMessageDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-mail-title"
      onClick={onClose}
    >
      <div className="card max-w-xl w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 pt-4">
          <h3 id="new-mail-title" className="text-lg font-semibold">
            New email
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
        <Composer
          accountId={accountId}
          provider={provider}
          aiEnabled={aiEnabled}
          isNew
          reply={null}
          context={[]}
          onSent={() => {
            onSent();
            onClose();
          }}
        />
      </div>
    </div>
  );
}
