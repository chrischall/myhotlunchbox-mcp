import { toolAnnotations, PositiveInt, schemaConfirm } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MhlbClient } from '../client.js';
import { jsonResult, preview, UNVERIFIED } from './_shared.js';

/** One row of `/parent/childrenInfo`. */
export interface ChildInfo {
  id: number;
  firstName: string;
  schoolName: string;
  hasOrders: boolean;
  orgType: number;
  gradeTeacher: string;
  isInactive: boolean;
  isInvited: boolean;
}

/**
 * The student form is a read-modify-write pair: `GET /parent/editChild` returns
 * the populated model, `POST /parent/editChild` takes it back. Rather than
 * guess at ~20 field names, tools hand the model through unchanged.
 */
const StudentModel = z
  .record(z.string(), z.unknown())
  .describe('The student model, as returned by mhlb_get_student_form / mhlb_new_student_form, with your edits applied.');

export function registerStudentTools(server: McpServer, client: MhlbClient): void {
  server.registerTool(
    'mhlb_list_students',
    {
      description:
        'List the students on the account: id, first name, school, grade/teacher, whether they have orders, ' +
        'and whether the profile is inactive or still an unaccepted invite. The student id feeds every ' +
        'calendar and ordering tool.',
      annotations: toolAnnotations({ title: 'List students', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get<ChildInfo[]>('/parent/childrenInfo')),
  );

  server.registerTool(
    'mhlb_get_student_form',
    {
      description:
        'Get the editable profile for one student — school, grade, teacher, delivery location, allergies and ' +
        'the dropdown options for each. Returns the exact model that mhlb_update_student expects back.',
      annotations: toolAnnotations({ title: 'Get student form', openWorld: true }),
      inputSchema: { studentId: PositiveInt.describe('Student id from mhlb_list_students.') },
    },
    async ({ studentId }) => jsonResult(await client.get('/parent/editChild', { childId: studentId })),
  );

  server.registerTool(
    'mhlb_new_student_form',
    {
      description:
        'Get a blank student profile plus the school/grade/teacher dropdown options, ready to fill in and ' +
        'pass to mhlb_create_student.',
      annotations: toolAnnotations({ title: 'New student form', openWorld: true }),
      inputSchema: {},
    },
    async () => jsonResult(await client.get('/parent/createChild')),
  );

  server.registerTool(
    'mhlb_create_student',
    {
      description:
        'Add a student to the account. Call mhlb_new_student_form first and send that model back with the ' +
        'fields filled in.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Create student', readOnly: false, openWorld: true }),
      inputSchema: { student: StudentModel, confirm: schemaConfirm },
    },
    async ({ student, confirm }) => {
      if (!confirm) return preview('Create student', { method: 'POST', path: '/parent/createChild', body: student });
      return jsonResult(await client.write('/parent/createChild', student));
    },
  );

  server.registerTool(
    'mhlb_update_student',
    {
      description:
        'Update a student profile. Call mhlb_get_student_form first and send that model back with your edits — ' +
        'the endpoint replaces the whole record, so omitted fields are lost.' + UNVERIFIED,
      annotations: toolAnnotations({ title: 'Update student', readOnly: false, openWorld: true }),
      inputSchema: { student: StudentModel, confirm: schemaConfirm },
    },
    async ({ student, confirm }) => {
      if (!confirm) {
        return preview('Update student', { method: 'POST', path: '/parent/editChild', body: student }, [
          'This is a whole-record replace: any field missing from `student` is cleared, not preserved.',
        ]);
      }
      return jsonResult(await client.write('/parent/editChild', student));
    },
  );

  server.registerTool(
    'mhlb_delete_student',
    {
      description:
        'Remove a student from the account. Irreversible from this API — their order history goes with them.' +
        UNVERIFIED,
      annotations: toolAnnotations({ title: 'Delete student', readOnly: false, openWorld: true }),
      inputSchema: {
        studentId: PositiveInt.describe('Student id from mhlb_list_students.'),
        confirm: schemaConfirm,
      },
    },
    async ({ studentId, confirm }) => {
      if (!confirm) {
        return preview(
          'Delete student',
          { method: 'POST', path: '/parent/deleteChild', query: { id: studentId } },
          ['Deleting a student is not reversible through this API.'],
        );
      }
      return jsonResult(await client.write('/parent/deleteChild', undefined, { id: studentId }));
    },
  );
}
