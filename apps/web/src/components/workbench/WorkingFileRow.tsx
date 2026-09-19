import type { WorkingFile } from "@fastwrite/shared";
import { Button, Icon, IconButton, icons } from "../ui";

/**
 * The marker a row shows. Untracked is `U` because that is what VSCode shows
 * and what users read; git's own short format uses `??` for untracked and `U`
 * for unmerged, so the two conventions collide — this component resolves the
 * collision in favour of the one people recognise, and gives conflicts `!`
 * instead.
 */
export function fileMarker(file: WorkingFile): string {
  if (file.conflicted) return "!";
  if (file.untracked) return "U";
  return file.unstaged ?? file.staged ?? "M";
}

export interface WorkingFileRowProps {
  file: WorkingFile;
  /** Which group is rendering it — decides which actions are offered. */
  group: "changes" | "staged" | "merge";
  onOpen: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}

export function WorkingFileRow({ file, group, onOpen, onStage, onUnstage, onDiscard }: WorkingFileRowProps) {
  const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const marker = fileMarker(file);
  return (
    <div className={`working-file working-file--${group}`}>
      {/*
        The row's own control is a library Button for the same reason its
        actions are: this file sits outside components/ui, where the raw-control
        guard forbids the bare element. Ghost, because the row is a list item
        rather than a toolbar action.
      */}
      <Button variant="ghost" size="small" className="working-file__open" onClick={onOpen} title={label}>
        <b className={`working-file__marker working-file__marker--${marker}`} aria-hidden="true">{marker}</b>
        <span className="working-file__path">{label}</span>
        {file.conflicted ? <span className="working-file__note">conflict</span> : null}
      </Button>
      {/*
        Actions are real buttons rather than decorative icons on the row, so they
        are reachable by Tab. A hover-only affordance is unreachable by keyboard,
        and this list is the sidebar's primary control surface.

        IconButton rather than Button with an Icon child: it is the library's
        icon-only control, so the accessible name lands on both aria-label and
        title in one place instead of being restated at each call site.
      */}
      <span className="working-file__actions">
        {group === "changes" && onStage ? <IconButton label={`Stage ${file.path}`} icon={<Icon name={icons.add} />} onClick={onStage} /> : null}
        {group === "changes" && onDiscard ? <IconButton label={`Discard changes in ${file.path}`} icon={<Icon name={icons.discard} />} onClick={onDiscard} /> : null}
        {group === "staged" && onUnstage ? <IconButton label={`Unstage ${file.path}`} icon={<Icon name={icons.discard} />} onClick={onUnstage} /> : null}
      </span>
    </div>
  );
}
