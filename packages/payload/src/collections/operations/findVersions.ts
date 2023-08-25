import { Where } from '../../types';
import { PayloadRequest } from '../../express/types';
import executeAccess from '../../auth/executeAccess';
import sanitizeInternalFields from '../../utilities/sanitizeInternalFields';
import { Collection } from '../config/types';
import type { PaginatedDocs } from '../../database/types';
import { TypeWithVersion } from '../../versions/types';
import { afterRead } from '../../fields/hooks/afterRead';
import { buildVersionCollectionFields } from '../../versions/buildCollectionFields';
import { validateQueryPaths } from '../../database/queryValidation/validateQueryPaths';
import { combineQueries } from '../../database/combineQueries';
import { initTransaction } from '../../utilities/initTransaction';
import { killTransaction } from '../../utilities/killTransaction';

export type Arguments = {
  collection: Collection
  where?: Where
  page?: number
  limit?: number
  sort?: string
  depth?: number
  req?: PayloadRequest
  overrideAccess?: boolean
  showHiddenFields?: boolean
}

async function findVersions<T extends TypeWithVersion<T>>(
  args: Arguments,
): Promise<PaginatedDocs<T>> {
  const {
    where,
    page,
    limit,
    depth,
    collection: {
      config: collectionConfig,
    },
    sort,
    req,
    req: {
      locale,
      payload,
    },
    overrideAccess,
    showHiddenFields,
  } = args;

  try {
    const shouldCommit = await initTransaction(req);

    // /////////////////////////////////////
    // Access
    // /////////////////////////////////////

    let accessResults;

    if (!overrideAccess) {
      accessResults = await executeAccess({ req }, collectionConfig.access.readVersions);
    }

    const versionFields = buildVersionCollectionFields(collectionConfig);

    await validateQueryPaths({
      collectionConfig,
      versionFields,
      where,
      req,
      overrideAccess,
    });

    const fullWhere = combineQueries(where, accessResults);

    // /////////////////////////////////////
    // Find
    // /////////////////////////////////////

    const paginatedDocs = await payload.db.findVersions<T>({
      where: fullWhere,
      page: page || 1,
      limit: limit ?? 10,
      collection: collectionConfig.slug,
      sort,
      locale,
      req,
    });

    // /////////////////////////////////////
    // beforeRead - Collection
    // /////////////////////////////////////

    let result = {
      ...paginatedDocs,
      docs: await Promise.all(paginatedDocs.docs.map(async (doc) => {
        const docRef = doc;
        await collectionConfig.hooks.beforeRead.reduce(async (priorHook, hook) => {
          await priorHook;

          docRef.version = await hook({
            req,
            query: fullWhere,
            doc: docRef.version,
            context: req.context,
          }) || docRef.version;
        }, Promise.resolve());

        return docRef;
      })),
    } as PaginatedDocs<T>;

    // /////////////////////////////////////
    // afterRead - Fields
    // /////////////////////////////////////

    result = {
      ...result,
      docs: await Promise.all(result.docs.map(async (data) => ({
        ...data,
        version: await afterRead({
          depth,
          doc: data.version,
          entityConfig: collectionConfig,
          overrideAccess,
          req,
          showHiddenFields,
          findMany: true,
          context: req.context,
        }),
      }))),
    };

    // /////////////////////////////////////
    // afterRead - Collection
    // /////////////////////////////////////

    result = {
      ...result,
      docs: await Promise.all(result.docs.map(async (doc) => {
        const docRef = doc;

        await collectionConfig.hooks.afterRead.reduce(async (priorHook, hook) => {
          await priorHook;

          docRef.version = await hook({
            req,
            query: fullWhere,
            doc: doc.version,
            findMany: true,
            context: req.context,
          }) || doc.version;
        }, Promise.resolve());

        return docRef;
      })),
    };

    // /////////////////////////////////////
    // Return results
    // /////////////////////////////////////

    result = {
      ...result,
      docs: result.docs.map((doc) => sanitizeInternalFields<T>(doc)),
    };

    if (shouldCommit) await payload.db.commitTransaction(req.transactionID);

    return result;
  } catch (error: unknown) {
    await killTransaction(req);
    throw error;
  }
}

export default findVersions;