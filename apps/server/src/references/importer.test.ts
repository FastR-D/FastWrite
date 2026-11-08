import { expect, test } from "bun:test";
import { publicReferenceAddress, referenceIdentifier, referenceUrl, resolveReferenceImport, type ReferenceDownloader } from "./importer";
const signal = () => new AbortController().signal;
const pdf = new TextEncoder().encode("%PDF-synthetic-full-text");

test("reference identifiers accept DOI, modern and legacy arXiv IDs, versions and full-text links", () => {
  for (const value of ["2301.12345v2", "arXiv:2301.12345v2", "https://arxiv.org/abs/2301.12345v2", "https://arxiv.org/pdf/2301.12345v2.pdf"]) expect(referenceIdentifier(value)).toEqual({ kind: "arxiv", value: "2301.12345v2" });
  expect(referenceIdentifier("hep-th/9901001v1")).toEqual({ kind: "arxiv", value: "hep-th/9901001v1" });
  expect(referenceIdentifier("https://doi.org/10.1234/paper.1")).toEqual({ kind: "doi", value: "10.1234/paper.1" });
  expect(referenceIdentifier("DOI:10.1234/paper.1").kind).toBe("doi");
  expect(referenceIdentifier("https://papers.example.org/paper.tex").kind).toBe("url");
  for (const value of ["", "not a paper", "arxiv:../secret", "http://example.org/paper.pdf"]) expect(() => referenceIdentifier(value)).toThrow();
});

test("remote references reject local, private, metadata and reserved addresses including IPv6", () => {
  for (const value of ["http://example.org/x", "https://user:password@example.org/x", "https://example.org:8080/x", "https://localhost/x", "https://foo.local/x", "https://127.1/x", "https://2130706433/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://169.254.169.254/latest"]) expect(() => referenceUrl(value)).toThrow();
  for (const address of ["10.1.2.3", "172.16.1.1", "192.168.1.1", "100.64.1.1", "198.18.0.1", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1", "2002:7f00:1::"]) expect(publicReferenceAddress(address)).toBe(false);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(publicReferenceAddress(address)).toBe(true);
});

test("arXiv and arXiv DOI imports retrieve full PDF content and reject HTML landing pages", async () => {
  const urls: string[] = []; const download: ReferenceDownloader = async url => { urls.push(url); return { bytes: pdf, contentType: "application/pdf" }; };
  expect((await resolveReferenceImport("arxiv:2301.12345v2", signal(), download)).bytes).toEqual(pdf);
  expect((await resolveReferenceImport("10.48550/arXiv.2301.12345", signal(), download)).name).toBe("arXiv-2301.12345.pdf");
  expect(urls).toEqual(["https://arxiv.org/pdf/2301.12345v2", "https://arxiv.org/pdf/2301.12345"]);
  await expect(resolveReferenceImport("2301.12345", signal(), async () => ({ bytes: new TextEncoder().encode("<html>Login</html>"), contentType: "text/html" }))).rejects.toThrow("未返回 PDF");
});

test("DOI import resolves publisher PDF links, tries alternatives and gives a useful missing-fulltext error", async () => {
  const urls: string[] = []; const download: ReferenceDownloader = async url => {
    urls.push(url);
    if (url.startsWith("https://api.crossref.org/works/")) return { bytes: new TextEncoder().encode(JSON.stringify({ message: { title: ["Example paper"], link: [{ URL: "https://publisher.example.org/login.pdf", "content-type": "application/pdf" }, { URL: "http://publisher.example.org/paper.pdf", "content-type": "application/pdf" }] } })), contentType: "application/json" };
    return { bytes: url.includes("login") ? new TextEncoder().encode("<html>Login</html>") : pdf, contentType: "application/pdf" };
  };
  const result = await resolveReferenceImport("10.1234/example", signal(), download);
  expect(result).toEqual({ name: "Example paper.pdf", bytes: pdf });
  expect(urls).toHaveLength(3); expect(urls[2]).toBe("https://publisher.example.org/paper.pdf");
  await expect(resolveReferenceImport("10.1234/example", signal(), async () => ({ bytes: new TextEncoder().encode('{"message": {"title": ["Metadata only"]}}'), contentType: "application/json" }))).rejects.toThrow("没有可直接下载");
});

test("direct LaTeX links preserve file type and remote validation runs before download", async () => {
  const bytes = new TextEncoder().encode("\\section{Introduction} Full source");
  const result = await resolveReferenceImport("https://papers.example.org/main.tex", signal(), async () => ({ bytes, contentType: "text/plain" }));
  expect(result).toEqual({ name: "main.tex", bytes });
  let called = false;
  await expect(resolveReferenceImport("https://127.0.0.1/paper.pdf", signal(), async () => { called = true; return { bytes: pdf, contentType: "application/pdf" }; })).rejects.toThrow();
  expect(called).toBe(false);
});
