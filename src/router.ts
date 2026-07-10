/**
 * 轻量路由辅助模块。
 * 使用 URLPattern 进行路径匹配，提供统一的路由分发机制。
 */

export type Handler = (request: Request, env: Record<string, unknown>) => Promise<Response> | Response;

export interface Route {
  method: string;
  /** URLPattern 兼容的路径模式，如 "/v1/models", "/v1/models/:id" */
  path: string;
  handler: Handler;
}

export interface RouterConfig {
  routes: Route[];
  notFoundHandler?: Handler;
}

/**
 * 创建路由分发器。
 * 按 routes 数组顺序匹配，首个匹配的 handler 被调用。
 * 匹配结果中的路径参数通过 `request._routeParams` 传递（仅内部使用）。
 */
export function createRouter(config: RouterConfig): Handler {
  const compiled = config.routes.map((r) => ({
    method: r.method.toUpperCase(),
    pattern: new URLPattern({ pathname: r.path }),
    handler: r.handler,
  }));

  const notFound: Handler =
    config.notFoundHandler ??
    (() => new Response('Not Found', { status: 404 }));

  return (request: Request, env: unknown) => {
    const method = request.method.toUpperCase();

    for (const route of compiled) {
      if (route.method !== '*' && route.method !== method) continue;

      const result = route.pattern.exec(request.url);
      if (result) {
        return route.handler(request, env as Record<string, unknown>);
      }
    }

    return notFound(request, env as Record<string, unknown>);
  };
}
