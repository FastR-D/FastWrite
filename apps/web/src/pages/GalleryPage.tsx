import { useState } from "react";
import {
  Alert, Badge, Button, Checkbox, Disclosure, Divider, EmptyState, Field, FileField, Icon, IconButton, icons,
  Label, Link, List, ListEmpty, ListRow, ListRowText, Loader, MultiSelect, NumberField, ProgressBar,
  SegmentedControl, Select, Spinner, StatusBar, StatusItem, Table, TableCell, TableRow,
  Tag, TextArea, TextField, Tooltip, View
} from "../components/ui";
import styles from "./GalleryPage.module.css";

const PROJECTS = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma" },
  // Kept last so the interaction swatches above are unaffected by it.
  { value: "archived", label: "Archived (read-only)", disabled: true }
];

const PUBLICATIONS = [
  { label: "CCF-A conferences", options: [{ value: "ccs", label: "CCS" }, { value: "sp", label: "S&P" }] },
  { label: "CCF-A journals", options: [{ value: "tifs", label: "TIFS" }, { value: "tdsc", label: "TDSC" }] }
];

/*
 * Twelve entries, so `searchable` engages on its own default (more than 10
 * options). This is the only catalogue entry that exercises the filter field —
 * and with it the editable-combobox path where the role moves onto the input.
 */
const CITY_VENUES = [
  "Aarhus", "Berlin", "Chicago", "Dresden", "Edinburgh", "Florence",
  "Geneva", "Helsinki", "Istanbul", "Jakarta", "Kyoto", "Lisbon"
].map((city) => ({ value: city.toLowerCase(), label: city }));

export function GalleryPage() {
  const [project, setProject] = useState("");
  const [publication, setPublication] = useState("");
  const [city, setCity] = useState("");
  const [skills, setSkills] = useState<string[]>(["draft"]);
  const [size, setSize] = useState<number | undefined>(120);
  const [agree, setAgree] = useState(false);
  const [name, setName] = useState("A secure systems paper");
  const [outlineMode, setOutlineMode] = useState<"current" | "project">("current");
  const [sizeMode, setSizeMode] = useState<"small" | "medium" | "wide">("medium");

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>FastWrite UI</h1>
          <div className={styles.subtitle}>Component catalogue · vscrui-based</div>
        </div>
        <Button variant="ghost" size="small" onClick={() => { window.location.assign("/"); }}>Back to projects</Button>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Buttons</h2>
        <p className={styles.sectionNote}>One primary action per region. Icon-only buttons always carry an accessible name.</p>
        <div className={styles.row}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Destructive</Button>
          <Button variant="primary" loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className={styles.row}>
          <Button variant="secondary" size="small">Small</Button>
          <IconButton label="Search the project" icon={<Icon name={icons.search} />} />
          <IconButton label="Delete draft" variant="danger" icon={<Icon name={icons.trash} />} />
          <IconButton label="Refresh" variant="secondary" icon={<Icon name={icons.refresh} />} />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Text inputs</h2>
        <p className={styles.sectionNote}>Field owns the label, hint and error relationship, including aria-describedby.</p>
        <div className={styles.column}>
          <Field label="Project name" hint="Shown in the projects list.">
            {({ id, describedBy, invalid }) => (
              <TextField id={id} aria-describedby={describedBy} invalid={invalid} value={name} onChange={setName} />
            )}
          </Field>
          <Field label="Workspace path" error="Use a path inside the managed workspace.">
            {({ id, describedBy, invalid }) => (
              <TextField id={id} aria-describedby={describedBy} invalid={invalid} defaultValue="../escape.tex" />
            )}
          </Field>
          <Field label="Abstract" hint="Markdown and LaTeX both accepted.">
            {({ id, describedBy }) => (
              <TextArea id={id} aria-describedby={describedBy} rows={3} defaultValue="We present…" />
            )}
          </Field>
          <Field label="Main-body pages" error="This venue caps the main body at 12 pages.">
            {({ id, describedBy, invalid }) => (
              <NumberField id={id} aria-describedby={describedBy} invalid={invalid} value={size} onChange={setSize} min={1} step={1} />
            )}
          </Field>
          <Field label="Template file" error="Only .tex templates are accepted.">
            {({ id, describedBy, invalid }) => (
              <FileField id={id} label="Template file" aria-describedby={describedBy} invalid={invalid} accept=".tex" onSelect={() => undefined} />
            )}
          </Field>
          <div className={styles.row}>
            <Label htmlFor="gallery-inline">Inline label</Label>
            <NumberField aria-label="Priority" compact defaultValue={3} min={0} />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Select</h2>
        <p className={styles.sectionNote}>
          Custom combobox: arrow keys, Home/End, typeahead, Escape. Over 10 options it gains a filter field.
        </p>
        <div className={styles.column}>
          <Field label="Project">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} aria-label="Project" options={PROJECTS} value={project} onChange={setProject} placeholder="Choose a project" />
            )}
          </Field>
          <Field label="Publication target" hint="Rendered as labelled groups.">
            {({ id }) => (
              <Select id={id} aria-label="Publication target" options={PUBLICATIONS} value={publication} onChange={setPublication} placeholder="Choose a venue" />
            )}
          </Field>
          <Field label="Long list" hint="More than 10 options, so the filter field engages.">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} aria-label="Long list" options={CITY_VENUES} value={city} onChange={setCity} placeholder="Choose a city" />
            )}
          </Field>
          <Field label="Task Skills" hint="Applies to the next skill run.">
            {({ describedBy, invalid }) => (
              <MultiSelect
                label="Task Skills"
                aria-describedby={describedBy}
                invalid={invalid}
                value={skills}
                onChange={setSkills}
                options={[
                  { value: "draft", label: "draft · produce an initial draft" },
                  { value: "continue", label: "continue · extend TODO sections" },
                  { value: "revise", label: "revise · apply reviewer feedback" }
                ]}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Selection and status</h2>
        <div className={styles.row}>
          {/*
           * A checkbox with no text of its own is exactly what Field's render
           * prop is for: the label names it through `id`, the error describes it
           * through `describedBy`, and both invalid flags come along.
           */}
          <Field label="Venue rules" error={agree ? undefined : "Accept the venue rules before compiling."}>
            {({ id, describedBy, invalid }) => (
              <Checkbox id={id} checked={agree} onChange={setAgree} aria-describedby={describedBy} invalid={invalid} />
            )}
          </Field>
          <Checkbox variant="pill" icon={<Icon name={icons.sparkle} />} checked={agree} onChange={setAgree}>Complete</Checkbox>
        </div>
        <div className={styles.row}>
          <Tag tone="success">Compiled</Tag>
          <Tag tone="danger">Version changed</Tag>
          <Tag tone="warning">Stale</Tag>
          <Tag tone="info">In review</Tag>
          <Badge label="3 unresolved issues">3</Badge>
        </div>
        <div className={styles.row}>
          <Spinner label="Loading template" />
          <Loader overlay={false} message="Preparing" />
          <Divider orientation="vertical" />
          <Icon name={icons.gitCompare} />
          <Icon name={icons.loading} spin />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Feedback</h2>
        <div className={styles.column}>
          <Alert tone="success">Compiled successfully.</Alert>
          <Alert tone="error" title="File version changed">Reload before saving.</Alert>
          <Alert tone="warning">Some venue rules could not be checked.</Alert>
          <Alert tone="info" actions={<Button size="small">Retry</Button>}>Applying venue rules…</Alert>
        </div>
        <div className={styles.column} style={{ marginTop: 14 }}>
          <ProgressBar label="Loading TeX bundles" value={68} detail="34.4 MB / 50.6 MB · core.data.gz" />
          <ProgressBar label="Compiling" />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Table</h2>
        <p className={styles.sectionNote}>A real table, so row and columnheader roles reach assistive technology.</p>
        <Table label="Recent audit events" columns={["Time", "Action", "Resource", "Actor"]} stripped>
          <TableRow>
            <TableCell>2026-09-18 09:14</TableCell>
            <TableCell>project.create</TableCell>
            <TableCell>project</TableCell>
            <TableCell>system</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>2026-09-18 09:31</TableCell>
            <TableCell>member.invite</TableCell>
            <TableCell>user</TableCell>
            <TableCell>owner@example.edu</TableCell>
          </TableRow>
        </Table>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Empty state and tooltip</h2>
        <p className={styles.sectionNote}>The tooltip appears on hover and on keyboard focus, and dismisses with Escape.</p>
        <div className={styles.row}>
          <EmptyState
            title="No review issues"
            detail="Run Review when the current version is ready."
            action={<Button size="small">Start review</Button>}
          />
        </div>
        <div className={styles.row} style={{ marginTop: 14 }}>
          <Tooltip content="Explains a compact icon action">
            <IconButton label="More information" icon={<Icon name={icons.info} />} />
          </Tooltip>
          <Tooltip content="Shown below when there is no room above" side="bottom">
            <Button size="small" variant="secondary">Hover or focus me</Button>
          </Tooltip>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Icons</h2>
        <p className={styles.sectionNote}>
          Icons are decorative by default and hidden from assistive technology, because the
          surrounding control carries the name. An icon that means something on its own takes
          an aria-label, which also keeps it exposed.
        </p>
        <div className={styles.row}>
          {/* Decorative: hidden, because the button's own label names it. */}
          <IconButton label="Search the project" icon={<Icon name={icons.search} />} />
          {/* Labelled: exposed as an image with a name, since nothing else names it. */}
          <Icon name={icons.error} aria-label="Compilation error" />
          <Icon name={icons.verified} aria-label="Verified evidence" />
          <Icon name={icons.fileText} />
          <Icon name={icons.loading} spin />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>View</h2>
        <div className={styles.row}>
          <View aria-label="Always visible" className={styles.grid ?? ""}>Visible by default</View>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Chrome</h2>
        <p className={styles.sectionNote}>Structural surfaces: navigation, grouping, disclosure and the status strip.</p>

        <div className={styles.row}>
          <Link href="/projects">Internal link</Link>
          <Link href="#gallery-anchor">Hash anchor</Link>
          <Link href="https://example.com" rel="noreferrer noopener" target="_blank">External link</Link>
          <Link href="/api/health" variant="button" download="health.json">Download as button</Link>
        </div>

        <div className={styles.row}>
          <SegmentedControl
            label="Outline source"
            value={outlineMode}
            onChange={setOutlineMode}
            options={[
              { value: "current", label: "Current document" },
              { value: "project", label: "Project structure" }
            ]}
          />
          <SegmentedControl
            label="Dialog size"
            bordered
            value={sizeMode}
            onChange={setSizeMode}
            options={[
              { value: "small", label: "S" },
              { value: "medium", label: "M" },
              { value: "wide", label: "L" }
            ]}
          />
        </div>

        <div className={styles.column} style={{ marginTop: 14 }}>
          <Disclosure summary="Pass coverage · 3 providers">
            <p>Provider, input boundary and per-pass issue counts would render here.</p>
          </Disclosure>
          <List label="Current changed files" compact>
            <ListRow onClick={() => undefined} selected><ListRowText primary="main.tex" secondary="modified" /></ListRow>
            <ListRow onClick={() => undefined}><ListRowText primary="sections/method.tex" secondary="added" /></ListRow>
            <ListRow><ListRowText primary="refs.bib" secondary="binary" /></ListRow>
            <ListEmpty>No further changes</ListEmpty>
          </List>
        </div>

        <div style={{ marginTop: 18 }}>
          <StatusBar label="Workspace status" className="workbench-status">
            <StatusItem>Managed history</StatusItem>
            <StatusItem>Local project</StatusItem>
            <StatusItem>Buffers acknowledged</StatusItem>
            <StatusItem trailing>Ln 1, Col 1</StatusItem>
          </StatusBar>
        </div>
      </section>
    </main>
  );
}
