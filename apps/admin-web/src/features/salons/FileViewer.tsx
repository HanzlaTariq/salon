import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Button, Skeleton } from '../../design-system';
import { ApiError, apiFetch } from '../../lib/api';
import { DOC_LABEL, SalonFileMeta } from './types';

/**
 * Fetches a short-lived signed URL on open (never cached) and shows it. Images are previewed;
 * PDFs are offered as a download (they are never rendered inline).
 */
export function FileViewer({ salonId, file, onClose }: { salonId: string; file: SalonFileMeta | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const q = useQuery({
    queryKey: ['salon-file-url', salonId, file?.id],
    enabled: file !== null,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => apiFetch<{ url: string; expiresInSec: number }>(`/admin/salons/${salonId}/files/${file!.id}/url`),
  });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (file && !d.open) d.showModal();
    if (!file && d.open) d.close();
  }, [file]);

  const err = q.error instanceof ApiError ? q.error : null;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      aria-label={file ? DOC_LABEL[file.docType] ?? 'File' : 'File'}
      className="m-auto w-[min(94vw,44rem)] rounded-sheet border border-line bg-surface p-5 text-fg shadow-soft backdrop:bg-black/50"
    >
      <h2 className="text-2xl">{file ? DOC_LABEL[file.docType] ?? 'File' : ''}</h2>
      <div className="mt-4 flex min-h-48 items-center justify-center">
        {q.isLoading ? <Skeleton className="h-48 w-full" /> : err ? (
          <p role="alert" className="text-danger">{err.message}</p>
        ) : q.data && file?.contentType === 'application/pdf' ? (
          <a className="font-semibold underline" href={q.data.url} target="_blank" rel="noopener noreferrer">Download PDF</a>
        ) : q.data ? (
          <img src={q.data.url} alt={file ? DOC_LABEL[file.docType] ?? 'Uploaded file' : ''} className="max-h-[70vh] max-w-full rounded-input object-contain" referrerPolicy="no-referrer" />
        ) : null}
      </div>
      <p className="mt-3 text-xs text-muted">This link expires in a few minutes. Viewing identity documents is recorded in the audit log.</p>
      <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </dialog>
  );
}
