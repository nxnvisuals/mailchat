// Tiny toast system with the same call shape the mail components expect:
//   const { toast } = useToast();
//   toast({ title, description, variant: "destructive" });

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export interface ToastInput {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ toast: (t: ToastInput) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { ...input, id }]);
      setTimeout(() => dismiss(id), input.variant === "destructive" ? 8000 : 5000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[calc(100vw-2rem)] max-w-sm" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`card p-3.5 pr-9 relative text-sm shadow-lg ${
              t.variant === "destructive" ? "border-destructive/40 bg-red-50" : ""
            }`}
          >
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="absolute top-2.5 right-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <p className={`font-medium ${t.variant === "destructive" ? "text-destructive" : ""}`}>{t.title}</p>
            {t.description && <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">{t.description}</p>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
