import type { PublicationTarget, ResearchDomainId } from "@fastwrite/shared";

const VENUE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  "acm-mm": "ACM MM", "artificial-intelligence": "AIJ", "ase-conference": "ASE", "eurocrypt": "EUROCRYPT", "journal-of-cryptology": "JoC", "proceedings-of-the-ieee": "Proc. IEEE", "usenix-atc": "USENIX ATC", "usenix-security": "USENIX Security", "ubicomp-imwut": "IMWUT", "ieee-vis": "IEEE VIS", "network-information-security": "SEC", "computer-architecture-systems": "ARCH", "computer-networks": "NET", "software-engineering-systems-languages": "SE/PL", "database-data-mining-retrieval": "DB/DM", "theoretical-computer-science": "TCS", "graphics-multimedia": "GFX", "human-computer-interaction": "HCI", "interdisciplinary-emerging": "XDISC",
  aaai: "AAAI", acl: "ACL", asplos: "ASPLOS", cav: "CAV", ccs: "CCS", chi: "CHI", crypto: "CRYPTO", cvpr: "CVPR", dac: "DAC", eccv: "ECCV", focs: "FOCS", fse: "FSE", hpca: "HPCA", iccv: "ICCV", icde: "ICDE", iclr: "ICLR", icml: "ICML", icse: "ICSE", ijcai: "IJCAI", isca: "ISCA", issta: "ISSTA", jacm: "JACM", jmlr: "JMLR", kdd: "KDD", lics: "LICS", neurips: "NeurIPS", ndss: "NDSS", nsdi: "NSDI", oopsla: "OOPSLA", osdi: "OSDI", pldi: "PLDI", popl: "POPL", sigcomm: "SIGCOMM", siggraph: "SIGGRAPH", sigir: "SIGIR", sigmod: "SIGMOD", sosp: "SOSP", sp: "S&P", stoc: "STOC", tpami: "T-PAMI", tse: "TSE", uist: "UIST", vldb: "VLDB", www: "WWW"
};

export function venueAbbreviation(venueId: string): string {
  return VENUE_ABBREVIATIONS[venueId] ?? venueId.replace(/-/g, " ").toUpperCase();
}

export function domainAbbreviation(domain: ResearchDomainId): string {
  return VENUE_ABBREVIATIONS[domain] ?? domain.toUpperCase();
}

export function publicationTargetAbbreviation(target: PublicationTarget | undefined, fallback: ResearchDomainId): string {
  return target ? venueAbbreviation(target.venueId) : domainAbbreviation(fallback);
}

export function venueOptionLabel(venue: { value: string; label: string }): string {
  return `${venueAbbreviation(venue.value)} — ${venue.label}`;
}
