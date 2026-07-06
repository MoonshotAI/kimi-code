/**
 * `edit` domain barrel — re-exports the App-scope edit capability: the pure
 * text core (`textModel`), the pure edit rules (`editService`), and the
 * os-backed `IFileEditService` contract (`fileEdit`) plus its scoped service
 * (`fileEditService`). Also re-exports the Agent-facing `EditTool` adapter
 * surface (`tools/edit`); exporting it evaluates the module so its
 * `registerTool(EditTool)` call runs at module load. Importing this barrel
 * registers the `IFileEditService` binding into the scope registry and adds
 * `Edit` to the tool contribution list.
 */

export * from './fileEdit';
export * from './fileEditService';
export * from './editService';
export * from './textModel';
export * from './tools/edit';
