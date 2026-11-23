import type { Course } from './types';
import { difficultCustomers } from './difficultCustomers';
import { WINTER_COURSES } from './winterSafety';

/** Every course, in the order the Training page lists them. Module ids must match backend COURSES. */
export const COURSES: Course[] = [difficultCustomers, ...WINTER_COURSES];

export function findCourse(id: string | undefined): Course | undefined {
  return COURSES.find(c => c.id === id);
}

export type { Course, Module, Block, Check, Video } from './types';
