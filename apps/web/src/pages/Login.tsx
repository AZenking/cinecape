/**
 * 登录页(T022,User Story 1 / FR-007/008)。
 *
 * - HeroUI 表单:用户名 + 密码;POST /auth/login(deviceType='web',
 *   deviceName 取 navigator.userAgent 前 60 字符,取不到则留空)。
 * - 成功:响应含 sessionToken → storeBearer → await refresh() → 跳转 /。
 * - 401:统一提示「用户名或密码错误」,绝不区分账号不存在/密码错误、
 *   不展示错误码(FR-008);其余错误给通用提示。
 * - 已登录访问 /login(status === 'authenticated')→ 重定向 /。
 * - 视觉(research D6):暗色优先、居中卡片 max-w-md、主按钮 44px(size=lg)。
 */
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import {
  Alert,
  Button,
  Card,
  FieldError,
  Form,
  Input,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { ApiError, api, storeBearer } from '../lib/api';
import { useSession } from '../lib/session';

/** FR-008:凭据错误统一话术,不区分账号存在性 */
const INVALID_CREDENTIALS_MESSAGE = '用户名或密码错误';

/** deviceName 截断长度(契约 deviceName.maxLength=100,取前 60 字符) */
const DEVICE_NAME_MAX = 60;

function readDeviceName(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const userAgent = navigator.userAgent.trim();
  return userAgent ? userAgent.slice(0, DEVICE_NAME_MAX) : undefined;
}

export function Login() {
  const { status, refresh } = useSession();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const trimmedUsername = username.trim();
    const errors: { username?: string; password?: string } = {};
    if (!trimmedUsername) {
      errors.username = '请输入用户名';
    }
    if (!password) {
      errors.password = '请输入密码';
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const session = await api.post('/auth/login', {
        username: trimmedUsername,
        password,
        deviceType: 'web',
        deviceName: readDeviceName(),
      });
      if (session.sessionToken) {
        storeBearer(session.sessionToken);
      }
      await refresh();
      setDone(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // FR-008:统一提示,不区分「账号不存在 / 密码错误」,不展示 code
        setFormError(INVALID_CREDENTIALS_MESSAGE);
      } else if (error instanceof ApiError) {
        setFormError(error.detail ?? '登录失败,服务暂不可用,请稍后重试。');
      } else {
        setFormError('登录失败,请稍后重试。');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const clearFieldError = (field: 'username' | 'password') => (value: string) => {
    if (field === 'username') {
      setUsername(value);
    } else {
      setPassword(value);
    }
    setFieldErrors((prev) => (prev[field] === undefined ? prev : { ...prev, [field]: undefined }));
  };

  // 已登录(或本次登录成功)→ 直接进入受保护主页
  if (done || status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xl font-semibold tracking-[0.3em] text-accent">HOME MEDIA</p>
          <p className="mt-2 text-sm text-muted">家庭媒体平台 · 登录</p>
        </header>

        <Card>
          <Card.Header>
            <Card.Title>欢迎回来</Card.Title>
            <Card.Description>使用主账号凭据登录,继续观看。</Card.Description>
          </Card.Header>
          <Card.Content>
            <Form className="flex flex-col gap-4" onSubmit={onSubmit} validationBehavior="aria">
              <TextField
                value={username}
                onChange={clearFieldError('username')}
                isInvalid={fieldErrors.username !== undefined}
                isRequired
                validationBehavior="aria"
                fullWidth
                autoComplete="username"
              >
                <Label>用户名</Label>
                <Input type="text" placeholder="输入用户名" />
                <FieldError>{fieldErrors.username}</FieldError>
              </TextField>

              <TextField
                value={password}
                onChange={clearFieldError('password')}
                isInvalid={fieldErrors.password !== undefined}
                isRequired
                validationBehavior="aria"
                fullWidth
                autoComplete="current-password"
              >
                <Label>密码</Label>
                <Input type="password" placeholder="输入密码" />
                <FieldError>{fieldErrors.password}</FieldError>
              </TextField>

              {formError && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>登录失败</Alert.Title>
                    <Alert.Description>{formError}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                isPending={submitting}
              >
                {submitting ? (
                  <>
                    <Spinner size="sm" color="current" />
                    登录中…
                  </>
                ) : (
                  '登录'
                )}
              </Button>
            </Form>
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
