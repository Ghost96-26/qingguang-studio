from __future__ import annotations

import threading
import traceback

from .providers import JobCancelled, ProviderRegistry
from .store import JobStore


class JobWorker:
    def __init__(self, store: JobStore, providers: ProviderRegistry, poll_seconds: float):
        self.store = store
        self.providers = providers
        self.poll_seconds = poll_seconds
        self.stop_event = threading.Event()
        self.maintenance = None
        self.thread = threading.Thread(target=self._run, name="gpu0-worker", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=5)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            if self.maintenance is not None:
                try:
                    self.maintenance()
                except Exception:
                    # Production coordination must not take down the GPU worker.
                    traceback.print_exc()
            job = self.store.claim()
            if job is None:
                self.stop_event.wait(self.poll_seconds)
                continue
            job_id = job["id"]

            def progress(value: float, stage: str, provider_run_id: str | None = None) -> None:
                self.store.progress(job_id, value, stage, provider_run_id)

            def cancelled() -> bool:
                return self.stop_event.is_set() or self.store.cancellation_requested(job_id)

            try:
                result = self.providers.execute(job, progress, cancelled)
                if cancelled():
                    self.store.finish(job_id, "cancelled", error="Cancellation requested")
                else:
                    self.store.finish(job_id, "succeeded", result=result)
            except JobCancelled as exc:
                self.providers.cleanup_failed(job)
                self.store.finish(job_id, "cancelled", error=str(exc))
            except Exception as exc:  # worker isolation boundary
                self.providers.cleanup_failed(job)
                detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-12000:]
                self.store.finish(job_id, "failed", error=detail)
