import { clientChineseText } from "@workloom/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { operationFailure, toUiFailure } from "../../../lib/ui-state";
import { beginBusinessAttempt, receiptId, type CommittedReceipt } from "./attempt";

export function useBusinessResource<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const order = ++sequence.current;
    setLoading(true);
    setMessage("");
    try {
      const result = await load();
      if (order === sequence.current) setValue(result);
    } catch (error) {
      if (order !== sequence.current) return;
      const failure = toUiFailure(error);
      setValue(null);
      setMessage(clientChineseText(failure.message, "读取未完成，请稍后重试。"));
    } finally {
      if (order === sequence.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
    return () => { sequence.current += 1; };
  }, [reload]);

  return { value, message, loading, reload };
}

export function useBusinessWrite(scope: string) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState("");
  const inflight = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  async function submit<T extends { receipt: CommittedReceipt }>(
    operation: string, payload: unknown, send: (idempotencyKey: string) => Promise<T>,
  ): Promise<T | null> {
    if (inflight.current) return null;
    inflight.current = true;
    const version = generation.current;
    setBusy(true);
    setMessage("");
    setReceipt("");
    try {
      const attempt = await beginBusinessAttempt(scope, operation, payload);
      const result = await send(attempt.idempotencyKey);
      const id = receiptId(result.receipt);
      if (id === null) throw new Error("服务端回执暂未校验");
      // A storage cleanup failure must not hide a business write that already has a receipt.
      try { attempt.release(); } catch {
        if (version === generation.current) setMessage("已收到回执。本机恢复标识暂未清除，同一请求重试会复用原标识。");
      }
      if (version !== generation.current) return null;
      setReceipt(id);
      return result;
    } catch (error) {
      if (version === generation.current) setMessage(operationFailure(error, operation));
      return null;
    } finally {
      inflight.current = false;
      if (version === generation.current) setBusy(false);
    }
  }

  return { busy, message, receipt, submit };
}
