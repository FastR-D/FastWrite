import { useEffect, useMemo, useState } from "react";
import type { PublicationTarget, PublicationVenueOption, WritingProfile } from "@fastwrite/shared";
import { api } from "../../api/client";
import { venueOptionLabel } from "../../lib/labels";

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
    <label className="field">
      <span>Target conference or journal</span>
      <select value={value?.venueId ?? ""} onChange={(event) => chooseVenue(event.target.value)}>
        <option value="">General domain guidance (no venue constraints)</option>
        <optgroup label="CCF-A conferences">{venues.filter((venue) => venue.kind === "conference").map((venue) => <option key={venue.value} value={venue.value}>{venueOptionLabel(venue)}</option>)}</optgroup>
        <optgroup label="CCF-A journals">{venues.filter((venue) => venue.kind === "journal").map((venue) => <option key={venue.value} value={venue.value}>{venueOptionLabel(venue)}</option>)}</optgroup>
      </select>
      <small>{selected ? `${selected.edition} · rules verified ${selected.verifiedAt}${selected.template ? ` · ${selected.template.trust === "official" ? "official template" : selected.template.trust === "publisher" ? "publisher-family template" : "community-mirrored template"}` : ""}` : "Agent, Revise, Review, and Completion use the selected venue's bundled constraints."}</small>
    </label>
    {value && templateYears.length ? <label className="field"><span>Template year</span><select value={value.year ?? Math.max(...templateYears)} onChange={(event) => onChange({ ...value, year: Number(event.target.value) })}>{templateYears.map((year) => <option key={year} value={year}>{year}</option>)}</select><small>Only officially verified template editions are offered.</small></label> : null}
    {value ? <label className="field"><span>Manuscript stage</span><select value={value.stage} onChange={(event) => onChange({ ...value, stage: event.target.value as PublicationTarget["stage"] })}><option value="draft">Draft</option><option value="submission">Anonymous submission</option><option value="camera-ready">Camera-ready</option></select></label> : null}
    {value && selected?.tracks?.length ? <label className="field"><span>Paper track</span><select value={value.track ?? selected.tracks[0]!.value} onChange={(event) => onChange({ ...value, track: event.target.value })}>{selected.tracks.map((track) => <option key={track.value} value={track.value}>{track.label}</option>)}</select></label> : null}
  </>;
}
