"use client";

import { useEffect, useId, useRef, useState } from "react";

export type ConfirmationRequest = {
  title: string;
  message: string;
  choices: Array<{ label: string; value: string; danger?: boolean }>;
  expectedText?: string;
};

export default function ConfirmationDialog({ request, onResolve }: { request: ConfirmationRequest; onResolve: (value: string | null) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return <dialog ref={dialogRef} className="confirm-modal app-confirm-dialog" aria-labelledby={titleId} aria-describedby={messageId} onCancel={event => { event.preventDefault(); onResolve(null); }}>
    <span className="warning">!</span><h2 id={titleId}>{request.title}</h2>
    <p id={messageId}>{request.message}</p>
    {request.expectedText && <label className="confirmation-text">输入“{request.expectedText}”确认
      <input value={text} onChange={event => setText(event.target.value)} autoComplete="off" />
    </label>}
    <div><button ref={cancelRef} className="secondary" onClick={() => onResolve(null)}>取消操作</button>
      {request.choices.map(choice => <button key={choice.value} className={choice.danger ? "danger" : "secondary"} disabled={Boolean(request.expectedText && text !== request.expectedText)} onClick={() => onResolve(request.expectedText ? text : choice.value)}>{choice.label}</button>)}
    </div>
  </dialog>;
}
