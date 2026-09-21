# demo-java —— Web Code Assistant 内置演示项目

一个极小的 Spring Boot 用户管理示例，专门用来演示 Web Code Assistant 的完整链路：

```
打开文件 → 提问 → Agent 读取项目 → 生成 unified diff → 前端预览 → 用户点「应用」→ 文件真正落盘
```

## 刻意留下的「待重构点」

这个项目里有一些真实项目常见、但应当被重构的写法。它们是给助手练手用的：

| 位置 | 问题 | 适合的提问 |
| --- | --- | --- |
| `UserService` | `@Autowired` 字段注入 | 「把 UserService 改成构造器注入」 |
| `UserController` | 同样是字段注入 | 「UserController 也一起改掉」 |
| `UserService.countActive` | 用下标 `for` 循环累加，可读性差 | 「countActive 用 Stream 重写」 |
| `UserService.rename` | 不校验用户名是否已被占用 | 「rename 也要做重名校验」 |
| `UserServiceTest` | 靠反射注入依赖 | 「重构之后把测试里的反射删掉」 |

## 本地跑起来

```bash
mvn spring-boot:run
curl http://localhost:8080/api/users
```

## 目录

```
src/main/java/com/demo/
  Application.java            启动类
  User.java                   领域对象（带 Bean Validation 注解）
  UserRepository.java         内存仓储
  UserService.java            领域服务（含待重构点）
  UserController.java         REST 控制器
  UserNotFoundException.java  领域异常
src/test/java/com/demo/
  UserServiceTest.java        单元测试
.coding-rules.md              团队规则，会被注入 AI 上下文
```
