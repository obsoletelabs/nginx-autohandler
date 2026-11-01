"""Atomic local JSON library with revision checks for stale browser tabs."""
import os
from pathlib import Path
import tempfile
from threading import RLock
from uuid import UUID

from .representation import Document, ModelError


class ConflictError(ModelError):
    pass


class DocumentStore:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()

    def _path(self, doc_id):
        try:
            return self.directory / (str(UUID(doc_id)) + ".json")
        except (ValueError, TypeError, AttributeError):
            raise ModelError("Invalid document id") from None

    def list(self):
        result = []
        with self.lock:
            for path in self.directory.glob("*.json"):
                doc = Document.from_json(path.read_text(encoding="utf-8"))
                result.append({"id": doc.id, "name": doc.name, "enabled": doc.enabled,
                               "revision": doc.revision, "files": len(doc.files)})
        return sorted(result, key=lambda item: item["name"].lower())

    def load(self, doc_id):
        with self.lock:
            return Document.from_json(self._path(doc_id).read_text(encoding="utf-8"))

    def save(self, document):
        doc = Document.from_dict(document.to_dict())
        path = self._path(doc.id)
        with self.lock:
            current_revision = self.load(doc.id).revision if path.exists() else 0
            if doc.revision != current_revision:
                raise ConflictError(f"Saved revision is {current_revision}; reload before overwriting this draft")
            doc.revision += 1
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.directory, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(doc.to_json())
            try:
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        return doc
