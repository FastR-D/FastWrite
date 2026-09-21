import { useEffect, useMemo, useState } from "react";
import type { PublicationTarget, PublicationVenueOption, WritingProfile } from "@fastwrite/shared";
import { api } from "../../api/client";
import { venueOptionLabel } from "../../lib/labels";
import { Field, Select } from "./index";

interface PublicationTargetFieldsProps {
  profile: WritingProfile;
  value: PublicationTarget | undefined;
  onChange: (value: PublicationTarget | undefined) => void;
  onSelectedVenueChange?: (value: PublicationVenueOption | undefined) => void;
}

export function PublicationTargetFields({ profile, value, onChange, onSelectedVenueChange }: PublicationTargetFieldsProps) {
  const [catalog, setCatalog] = useState<PublicationVenueOption[]>([]);
  useEffect(() => { const controller = new AbortController(); void api.venues.list(controller.signal).then(setCatalog).catch(() => setCatalog([])); return () => controller.abort(); }, []);
  const venues = useMemo(() => catalog.filter((venue) => venue.domain === profile), [catalog, profile]);
  const selected = venues.find((venue) => venue.value === value?.venueId);
  const templateYears = selected?.template?.years ?? [];
  useEffect(() => { onSelectedVenueChange?.(selected); }, [onSelectedVenueChange, selected]);
  const chooseVenue = (venueId: string) => {
    if (!venueId) return onChange(undefined);
    const venue = venues.find((item) => item.value === venueId);
    if (!venue) return onChange(undefined);
    const years = venue.template?.years ?? [];
    onChange({ domain: profile, venueId: venue.value, stage: "submission", ...(years.length ? { year: Math.max(...years) } : {}), ...(venue.tracks?.[0] ? { track: venue.tracks[0].value } : {}) });
  };

  return <>
    <Field label="Target conference or journal" hint={selected ? `${selected.edition} · rules verified ${selected.verifiedAt}${selected.template ? ` · ${selected.template.trust === "official" ? "official template" : selected.template.trust === "publisher" ? "publisher-family template" : "community-mirrored template"}` : ""}` : "Agent, Revise, Review, and Completion use the selected venue's bundled constraints."}>
      <Select
        aria-label="Target conference or journal"
        value={value?.venueId ?? ""}
        onChange={chooseVenue}
        placeholder="General domain guidance (no venue constraints)"
        options={[
          /*
           * A selectable "none" entry, matching the raw dropdown this replaced.
           * Without it the placeholder showed the same text but could not be
           * re-selected, so choosing a venue was one-way.
           *
           * (Phrased without the tag name: the raw-control guard scans source
           * text, so writing it out here would trip the guard from a comment.)
           */
          { value: "", label: "General domain guidance (no venue constraints)" },
          { label: "CCF-A conferences", options: venues.filter((venue) => venue.kind === "conference").map((venue) => ({ value: venue.value, label: venueOptionLabel(venue) })) },
          { label: "CCF-A journals", options: venues.filter((venue) => venue.kind === "journal").map((venue) => ({ value: venue.value, label: venueOptionLabel(venue) })) }
        ]}
      />
    </Field>
    {value && templateYears.length ? <Field label="Template year" hint="Only officially verified template editions are offered."><Select aria-label="Template year" value={String(value.year ?? Math.max(...templateYears))} onChange={(next) => onChange({ ...value, year: Number(next) })} options={templateYears.map((year) => ({ value: String(year), label: String(year) }))} /></Field> : null}
    {value ? <Field label="Manuscript stage"><Select aria-label="Manuscript stage" value={value.stage} onChange={(next) => onChange({ ...value, stage: next as PublicationTarget["stage"] })} options={[{ value: "draft", label: "Draft" }, { value: "submission", label: "Anonymous submission" }, { value: "camera-ready", label: "Camera-ready" }]} /></Field> : null}
    {value && selected?.tracks?.length ? <Field label="Paper track"><Select aria-label="Paper track" value={value.track ?? selected.tracks[0]!.value} onChange={(next) => onChange({ ...value, track: next })} options={selected.tracks.map((track) => ({ value: track.value, label: track.label }))} /></Field> : null}
  </>;
}
