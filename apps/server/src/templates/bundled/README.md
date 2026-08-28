# Bundled LaTeX templates

These files are vendored so template initialization works without a network request.

- `ccfa/` comes from `mikubaka88/CCFA-Skills` at commit `fd5c7e3afcc097d874d296a0e1e8118ae597f847` and contains the shared conference, journal, ACM, IEEE, Springer, and SIAM starting points used by the venue catalog.
- ICLR 2027 is downloaded from its official style archive on first use and cached under `FASTWRITE_DATA_DIR/templates/`; the official archive is published at `media.iclr.cc`.

PDFs, archives, and repository metadata are intentionally omitted. Venue metadata and source links remain defined in `latex-template-service.ts`; the service reads this directory before consulting its persistent cache or network fallback.
