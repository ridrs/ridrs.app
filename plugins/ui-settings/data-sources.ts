// SPDX-License-Identifier: AGPL-3.0-or-later

import { providerIdSchema, type SettingsDocument } from '@ridrs/contracts';
import { z } from 'zod';

/** The provider the rider chose for each data type that has a choice (ADR 0073), by data type. */
export const dataSourcesDocumentSchema = z
  .object({ sources: z.record(z.string().min(1), providerIdSchema) })
  .strict();

export type DataSourcesDocument = z.infer<typeof dataSourcesDocumentSchema>;

export const DATA_SOURCES_DOCUMENT: SettingsDocument<DataSourcesDocument> = {
  name: 'data-sources',
  version: 1,
  schema: dataSourcesDocumentSchema,
};
