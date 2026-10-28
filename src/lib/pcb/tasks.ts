/*
 * The heavy, pure pieces of PCB work that may run off the main thread: routing (up to tens of
 * seconds of search), the design rule check and drawing the board picture. Each takes the
 * project (and plain inputs) and returns plain data, so the same functions run in the worker,
 * in the page when there is no worker, and in the command line.
 */
import type { Project } from '../schematic/types';
import { autorouteProject, checkPcb } from './actions';
import { pcbPictureOf, type PictureInput } from './picture';

export const TASKS = {
  autoroute: (project: Project, net?: string, width?: number) => autorouteProject(project, net, width),
  check: (project: Project) => checkPcb(project).issues,
  render: (project: Project, input: PictureInput) => pcbPictureOf(project, input),
};

export type Tasks = typeof TASKS;
export type TaskName = keyof Tasks;
