"""Repository-relative paths for Python tooling. Mirrors tools/repo-paths.ts.

Resolved from this file's location, never from the working directory, so the
same checkout behaves identically on a Linux sandbox, on macOS and in CI.
"""
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS_ARCHITECTURE = os.path.join(REPO_ROOT, 'docs', 'architecture')


def repo_path(*segments):
    return os.path.join(REPO_ROOT, *segments)


def docs_output_dir():
    """Repository-owned by default; MACROS_DOCS_OUT redirects artifact export."""
    return os.environ.get('MACROS_DOCS_OUT') or DOCS_ARCHITECTURE


def architecture_doc(filename):
    return os.path.join(docs_output_dir(), filename)


def source_dir():
    """Owner-supplied archives. MACROS_SOURCE_DIR points at the real location."""
    return os.environ.get('MACROS_SOURCE_DIR') or os.path.join(REPO_ROOT, 'data', 'sources')


def source_file(filename):
    return os.path.join(source_dir(), filename)
