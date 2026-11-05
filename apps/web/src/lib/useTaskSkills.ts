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
  "anti-defensive-writing": "反防御性写作（中文）",
  "anti-defensive-writing-en": "反防御性写作（英文）",
  "claim-audit": "论断与证据核查",
  "experiment-design": "实验设计",
  "latex-structure": "LaTeX 结构优化",
  "related-work-map": "相关工作梳理",
  "threat-model": "威胁模型",
};

export function taskSkillLabel(id: string) { return labels[id] ?? id; }
