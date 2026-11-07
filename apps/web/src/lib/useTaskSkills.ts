import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentTaskSkillDescriptor } from "@fastwrite/shared";
import { api } from "../api/client";

export const MAX_TASK_SKILLS = 5;

function storageKey(projectId: string) { return `fastwrite.task-skills:${projectId}`; }

function readSelection(projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(0, MAX_TASK_SKILLS) : [];
  } catch { return []; }
}

export function useTaskSkills(projectId: string, revision: number) {
  const [skills, setSkills] = useState<AgentTaskSkillDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const storedIds = useMemo(() => selections[projectId] ?? readSelection(projectId), [projectId, selections]);
  const selectedIds = useMemo(() => loaded ? storedIds.filter(id => skills.some(skill => skill.id === id)) : storedIds, [loaded, skills, storedIds]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api.agentSkills.list(controller.signal).then(items => {
      if (!controller.signal.aborted) { setSkills(items); setLoaded(true); }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载内置 Skill");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, revision]);

  const setSelectedIds = useCallback((ids: string[]) => {
    const next = [...new Set(ids)].filter(id => skills.some(skill => skill.id === id)).slice(0, MAX_TASK_SKILLS);
    setSelections(current => ({ ...current, [projectId]: next }));
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(next)); } catch { /* Keep the selection for this session if storage is unavailable. */ }
  }, [projectId, skills]);

  return { skills, selectedIds, setSelectedIds, loading, error };
}

const labels: Record<string, string> = {
  "paper-reading-notes": "文献精读与写作卡片",
  "evidence-storyline": "论文主线与引言构建",
  "experiment-reporting": "实验章节证据化写作",
  "results-discussion": "结果解读与讨论写作",
  "figure-caption-audit": "图表证据与图注核查",
  "manuscript-consistency": "全文主张与证据一致性",
  "scientific-writing": "科学论文证据化写作",
  "literature-synthesis": "文献证据综合",
  "citation-verification": "引用与书目核验",
  "structured-peer-review": "结构化同行评审",
  "academic-prose-polish": "学术表达精修",
  "reviewer-response": "审稿意见逐条回复",
  "research-content-writing": "研究型内容写作",
  "anti-defensive-writing": "反防御性写作（中文）",
  "anti-defensive-writing-en": "反防御性写作（英文）",
  "claim-audit": "论断与证据核查",
  "experiment-design": "实验设计",
  "latex-structure": "LaTeX 结构优化",
  "related-work-map": "相关工作梳理",
  "threat-model": "威胁模型",
};

export function taskSkillLabel(id: string) { return labels[id] ?? id; }

export const WRITING_STAGE_PRESETS = [
  { label: "文献入稿", ids: ["paper-reading-notes", "literature-synthesis"] },
  { label: "搭建主线", ids: ["evidence-storyline", "scientific-writing"] },
  { label: "撰写实验", ids: ["experiment-reporting"] },
  { label: "解读结果", ids: ["results-discussion"] },
  { label: "核对图注", ids: ["figure-caption-audit"] },
  { label: "全文复核", ids: ["manuscript-consistency", "academic-prose-polish"] },
];
