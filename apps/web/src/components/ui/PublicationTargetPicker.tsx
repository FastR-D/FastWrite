import { useEffect, useMemo, useState } from "react";
import { WRITING_PROFILES, type PublicationTarget, type PublicationVenueOption, type WritingProfile } from "@fastwrite/shared";
import { api } from "../../api/client";
import { venueAbbreviation, venueOptionLabel } from "../../lib/labels";
import { BreadcrumbSelect, type BreadcrumbSelectStep } from "./controls/BreadcrumbSelect";

interface PublicationTargetPickerProps {
  profile: WritingProfile;
  onProfileChange: (profile: WritingProfile) => void;
  value: PublicationTarget | undefined;
  onChange: (value: PublicationTarget | undefined) => void;
  onSelectedVenueChange?: (value: PublicationVenueOption | undefined) => void;
  disabled?: boolean;
}

export function PublicationTargetPicker({ profile, onProfileChange, value, onChange, onSelectedVenueChange, disabled = false }: PublicationTargetPickerProps) {
  const [catalog, setCatalog] = useState<PublicationVenueOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    void api.venues.list(controller.signal).then(setCatalog).catch(failure => {
      if ((failure as DOMException).name !== "AbortError") setFailed(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const venues = useMemo(() => catalog.filter(venue => venue.domain === profile), [catalog, profile]);
  const selected = venues.find(venue => venue.value === value?.venueId);
  const years = selected?.template?.years ?? [];
  useEffect(() => { onSelectedVenueChange?.(selected); }, [onSelectedVenueChange, selected]);
  const steps: BreadcrumbSelectStep[] = [
    { id: "domain", label: "研究领域", value: profile, options: WRITING_PROFILES.map(item => ({ value: item.value, label: item.label })), onChange: next => { onProfileChange(next as WritingProfile); onChange(undefined); } },
    { id: "venue", label: "目标会议或期刊", value: value?.venueId ?? "", disabled: loading, placeholder: loading ? "加载目标…" : "通用领域指导", options: [
      { value: "", label: "通用领域指导" },
      ...(failed ? [{ value: "__retry__", label: "加载失败，点击重试" }] : []),
      ...[
        { label: "CCF A 类会议", options: venues.filter(venue => venue.kind === "conference").map(venue => ({ value: venue.value, label: venueOptionLabel(venue), shortLabel: venueAbbreviation(venue.value) })) },
        { label: "CCF A 类期刊", options: venues.filter(venue => venue.kind === "journal").map(venue => ({ value: venue.value, label: venueOptionLabel(venue), shortLabel: venueAbbreviation(venue.value) })) },
      ].filter(group => group.options.length),
    ], onChange: venueId => {
      if (venueId === "__retry__") { setAttempt(current => current + 1); return; }
      const venue = venues.find(item => item.value === venueId);
      if (!venue) { onChange(undefined); return; }
      const templateYears = venue.template?.years ?? [];
      onChange({ domain: profile, venueId: venue.value, stage: "submission", ...(templateYears.length ? { year: Math.max(...templateYears) } : {}), ...(venue.tracks?.[0] ? { track: venue.tracks[0].value } : {}) });
    } },
  ];
  if (value && years.length) steps.push({ id: "year", label: "模板年份", value: String(value.year ?? Math.max(...years)), options: years.map(year => ({ value: String(year), label: `${year} 年` })), onChange: year => onChange({ ...value, year: Number(year) }) });
  if (value) steps.push({ id: "stage", label: "稿件阶段", value: value.stage, options: [{ value: "draft", label: "初稿" }, { value: "submission", label: "匿名投稿" }, { value: "camera-ready", label: "终稿" }], onChange: stage => onChange({ ...value, stage: stage as PublicationTarget["stage"] }) });
  if (value && selected?.tracks?.length) steps.push({ id: "track", label: "论文类别", value: value.track ?? selected.tracks[0]!.value, options: selected.tracks.map(track => ({ ...track })), onChange: track => onChange({ ...value, track }) });
  return <BreadcrumbSelect label="研究领域与投稿目标" steps={steps} disabled={disabled} />;
}
