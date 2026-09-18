export interface NavigationRequest {
  requestId: number;
  projectId: string;
  path: string;
  line: number;
}

/** Latest intent wins, including manual file selection and repeated same-line jumps. */
export class NavigationController {
  private generation = 0;
  begin(projectId: string, path: string, line = 1): NavigationRequest {
    return { requestId: ++this.generation, projectId, path, line };
  }
  cancel() { this.generation++; }
  isCurrent(request: NavigationRequest) { return request.requestId === this.generation; }
}
