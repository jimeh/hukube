import type {
  Cluster,
  ClusterParams,
  ClusterStatus,
  FindParams,
  FindResult,
  Method,
  QueryParams,
  QueryResult,
  ResourceData,
  ResourceRef,
  ResourceType,
  Setting,
  SettingKey,
} from "./protocol.gen.ts";

/** Params and result types of each request method, per engine/internal/protocol. */
export interface Requests {
  "clusters.list": { params: undefined; result: Cluster[] };
  "settings.put": { params: Setting; result: undefined };
}

/** Params and data types of each subscription topic, per engine/internal/protocol. */
export interface Topics {
  "cluster.status": { params: ClusterParams; data: ClusterStatus };
  "cluster.types": { params: ClusterParams; data: ResourceType[] };
  "resources.query": { params: QueryParams; data: QueryResult };
  "resources.find": { params: FindParams; data: FindResult };
  "resource.get": { params: ResourceRef; data: ResourceData };
  "settings.watch": { params: SettingKey; data: Setting };
}

export type RequestMethod = keyof Requests;
export type TopicMethod = keyof Topics;

// Fails to compile when the Engine gains a method these maps do not describe.
type Assert<T extends true> = T;
export type _EveryMethodIsTyped = Assert<Method extends RequestMethod | TopicMethod ? true : false>;
