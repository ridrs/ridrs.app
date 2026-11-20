// Opening a ridrs Scenic job file (<id>.v2g.json, by drop or "Scenic-Job öffnen …"): a new project with the job's URL, title and the
// hints the app already has (search frame, start/end frame, route hint, vehicle; src/atlas.ts jobPlan), and the atlas link in app.json.
// The video is not loaded here: the user starts the import with their own template (P2).
import { api } from "../api";
import { jobPlan, parseJob } from "../atlas";
import { refreshProjects } from "../app/project";
import { toast } from "../state";

export const isJobPath = (p: string) => /\.v2g\.json$/i.test(p);

/** Creates the project of a job file. Returns its id, or null (the reason was shown). */
export async function openJobFile(path: string): Promise<string | null> {
  let plan;
  try { plan = jobPlan(parseJob(await api.atlasJobRead(path))); }
  catch (e) { toast(`Job-Datei nicht geöffnet: ${e instanceof Error ? e.message : e}`, "error"); return null; }
  const app = await api.projectCreate(plan.name, null);
  Object.assign(app, { bbox: plan.bbox, start_frame: plan.start_frame, end_frame: plan.end_frame, vehicle: plan.vehicle, atlas: plan.atlas,
    // the job's frame is the search frame: no suggestion from the title
    suggested: !!plan.bbox });
  await api.projectSave(app.id, app);
  if (plan.hint) {
    try {
      const h = await api.atlasHintDownload(app.id, plan.hint.url, plan.hint.name);
      app.hint = { name: h.name, path: h.path, buffer_m: plan.hint.buffer_m };
      await api.projectSave(app.id, app);
    } catch (e) {
      toast(`Die Route aus ridrs Scenic wurde nicht geladen; das Projekt sucht im ganzen Suchrahmen. (${e instanceof Error ? e.message : e})`, "error");
    }
  }
  await refreshProjects();
  return app.id;
}
