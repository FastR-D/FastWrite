import type { DocumentRegistry } from "../../lib/editor/documentRegistry";
import { Icon, IconButton, icons } from "../ui";
import { WorkingChangesView } from "./WorkingChangesView";

export interface DiffRequest { baseRef: string; targetRef: string; path: string; oldPath?: string; projectVersion?: number; }

/**
 * The Source Control sidebar.
 *
 * Phase A shows only the working tree. Checkpoint history, comparing two
 * checkpoints and restoring a file have no entry point until the Graph view
 * lands — their server routes are all still live, and the e2e cases that drove
 * them through this panel were removed with a note rather than left failing.
 */
export function SourceControlView({ projectId, version, selectedPath, onCompare, onCommit, onFlush, onSync }: {
  /**
   * The editor's document registry. Phase A does not read it — the old list
   * merged unsaved buffers into its rows, and the new one reports git state
   * only, as VSCode does. Kept in the signature because WorkspacePage passes it
   * and Phase B restores the buffer-aware actions; dropping it from the call
   * site would have to be undone there.
   */
  registry: DocumentRegistry;
  projectId: string;
  version: number;
  selectedPath: string | null;
  onCompare: (request: DiffRequest) => void;
  onCommit: (message: string) => Promise<void>;
  /**
   * Flushes pending editor saves to disk. Every working-tree mutation needs it
   * first — see the comment on `act` in WorkingChangesView.
   */
  onFlush: () => Promise<void>;
  onSync?: () => void;
}) {
  return <section className="source-control-view" aria-label="Source control">
    <header className="panel-heading"><span>Source Control</span>{onSync ? <IconButton label="Sync with GitHub" icon={<Icon name={icons.sync} />} onClick={onSync} /> : null}</header>
    <WorkingChangesView projectId={projectId} version={version} selectedPath={selectedPath} onCompare={onCompare} onCommit={onCommit} onFlush={onFlush} />
  </section>;
}
