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
    <Field label="目标会议或期刊" hint={selected ? `${selected.edition} · 规则核实于 ${selected.verifiedAt}${selected.template ? ` · ${selected.template.trust === "official" ? "官方模板" : selected.template.trust === "publisher" ? "出版社通用模板" : "社区镜像模板"}` : ""}` : "智能助手、修改、审稿和补全将使用所选会议或期刊的内置规则。"}>
      <Select
        aria-label="目标会议或期刊"
        value={value?.venueId ?? ""}
        onChange={chooseVenue}
        placeholder="通用领域指导（不限定会议或期刊）"
        options={[
          /*
           * A selectable "none" entry, matching the raw dropdown this replaced.
           * Without it the placeholder showed the same text but could not be
           * re-selected, so choosing a venue was one-way.
           *
           * (Phrased without the tag name: the raw-control guard scans source
           * text, so writing it out here would trip the guard from a comment.)
           */
          { value: "", label: "通用领域指导（不限定会议或期刊）" },
          { label: "CCF A 类会议", options: venues.filter((venue) => venue.kind === "conference").map((venue) => ({ value: venue.value, label: venueOptionLabel(venue) })) },
          { label: "CCF A 类期刊", options: venues.filter((venue) => venue.kind === "journal").map((venue) => ({ value: venue.value, label: venueOptionLabel(venue) })) }
        ]}
      />
    </Field>
    {value && templateYears.length ? <Field label="模板年份" hint="仅提供已核实的官方模板版本。"><Select aria-label="模板年份" value={String(value.year ?? Math.max(...templateYears))} onChange={(next) => onChange({ ...value, year: Number(next) })} options={templateYears.map((year) => ({ value: String(year), label: String(year) }))} /></Field> : null}
    {value ? <Field label="稿件阶段"><Select aria-label="稿件阶段" value={value.stage} onChange={(next) => onChange({ ...value, stage: next as PublicationTarget["stage"] })} options={[{ value: "draft", label: "初稿" }, { value: "submission", label: "匿名投稿" }, { value: "camera-ready", label: "终稿" }]} /></Field> : null}
    {value && selected?.tracks?.length ? <Field label="论文类别"><Select aria-label="论文类别" value={value.track ?? selected.tracks[0]!.value} onChange={(next) => onChange({ ...value, track: next })} options={selected.tracks.map((track) => ({ value: track.value, label: track.label }))} /></Field> : null}
  </>;
}
