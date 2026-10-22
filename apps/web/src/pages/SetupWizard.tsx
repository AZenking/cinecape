/**
 * 初始化向导(T021,User Story 1 / FR-002/003)。
 *
 * - 挂载时 GET /setup/status:已初始化(initialized=true)→ 重定向 /login;
 *   检查失败给出错误提示与重试入口。
 * - HeroUI 表单:家庭名称(必填)、用户名(必填 3-64)、密码(必填 ≥8,二次确认)、
 *   可选默认语言/时区(缺省 zh-CN / Asia/Shanghai,契约 InitializeRequest)。
 * - 客户端校验先行(必填/长度/两次密码一致),错误就地显示(FieldError)。
 * - 提交 POST /setup/initialize:成功且响应含 sessionToken → storeBearer →
 *   await refresh() → 跳转 /;409(INITIALIZATION_ALREADY_DONE)→ 提示已初始化
 *   并给去登录链接;code=VALIDATION_FAILED → 展示服务端 detail。
 * - 视觉(research D6):暗色优先、居中卡片 max-w-md、主按钮 44px(size=lg)。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
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

/** 客户端校验边界(与契约 InitializeRequest 对齐) */
const HOUSEHOLD_NAME_MAX = 100;
const USERNAME_MIN = 3;
const USERNAME_MAX = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/** 可选项缺省值(契约 default) */
const DEFAULT_LANGUAGE = 'zh-CN';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 向导表单字段(含仅客户端的二次密码确认) */
interface SetupFormValues {
  householdName: string;
  username: string;
  password: string;
  confirmPassword: string;
  defaultLanguage: string;
  timezone: string;
}

type SetupField = keyof SetupFormValues;
type FieldErrors = Partial<Record<SetupField, string>>;

/** 提交后的整体错误提示(Alert 呈现) */
interface SubmitError {
  title: string;
  description?: string;
  /** true = 409 已初始化:额外渲染「前往登录」入口 */
  alreadyInitialized?: boolean;
}

const INITIAL_VALUES: SetupFormValues = {
  householdName: '',
  username: '',
  password: '',
  confirmPassword: '',
  defaultLanguage: DEFAULT_LANGUAGE,
  timezone: DEFAULT_TIMEZONE,
};

/** 客户端校验:必填 / 长度 / 两次密码一致;返回字段级错误(空对象 = 通过) */
function validateForm(values: SetupFormValues): FieldErrors {
  const errors: FieldErrors = {};

  const householdName = values.householdName.trim();
  if (!householdName) {
    errors.householdName = '请输入家庭名称';
  } else if (householdName.length > HOUSEHOLD_NAME_MAX) {
    errors.householdName = `家庭名称不能超过 ${HOUSEHOLD_NAME_MAX} 个字符`;
  }

  const username = values.username.trim();
  if (!username) {
    errors.username = '请输入用户名';
  } else if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    errors.username = `用户名长度需在 ${USERNAME_MIN}-${USERNAME_MAX} 个字符之间`;
  }

  if (!values.password) {
    errors.password = '请输入密码';
  } else if (values.password.length < PASSWORD_MIN) {
    errors.password = `密码至少 ${PASSWORD_MIN} 位`;
  } else if (values.password.length > PASSWORD_MAX) {
    errors.password = `密码最多 ${PASSWORD_MAX} 位`;
  }

  if (!values.confirmPassword) {
    errors.confirmPassword = '请再次输入密码';
  } else if (values.confirmPassword !== values.password) {
    errors.confirmPassword = '两次输入的密码不一致';
  }

  return errors;
}

export function SetupWizard() {
  const { refresh } = useSession();

  // 初始化状态检查(GET /setup/status)
  const [checking, setChecking] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // 表单与提交
  const [values, setValues] = useState<SetupFormValues>(INITIAL_VALUES);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const checkStatus = useCallback(async (): Promise<void> => {
    setChecking(true);
    setCheckError(null);
    try {
      const status = await api.get('/setup/status');
      setInitialized(status.initialized);
    } catch {
      setCheckError('无法获取初始化状态,请确认服务已启动后重试。');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  /** 受控输入:写入值并就地清除该字段校验错误 */
  const setField = (field: SetupField) => (value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => (prev[field] === undefined ? prev : { ...prev, [field]: undefined }));
  };

  const submit = useCallback(async (): Promise<void> => {
    const errors = validateForm(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const session = await api.post('/setup/initialize', {
        householdName: values.householdName.trim(),
        username: values.username.trim(),
        password: values.password,
        defaultLanguage: values.defaultLanguage.trim() || DEFAULT_LANGUAGE,
        timezone: values.timezone.trim() || DEFAULT_TIMEZONE,
      });
      if (session.sessionToken) {
        storeBearer(session.sessionToken);
      }
      await refresh();
      setDone(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSubmitError({
          title: '平台已完成初始化',
          description: '检测到家庭与主账号已存在,无需重复初始化,请直接登录。',
          alreadyInitialized: true,
        });
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        setSubmitError({
          title: '提交信息未通过服务端校验',
          description: error.detail ?? '请检查各字段后重试。',
        });
      } else if (error instanceof ApiError) {
        setSubmitError({
          title: '初始化失败',
          description: error.detail ?? '服务暂不可用,请稍后重试。',
        });
      } else {
        setSubmitError({ title: '初始化失败', description: '发生意外错误,请稍后重试。' });
      }
    } finally {
      setSubmitting(false);
    }
  }, [values, refresh]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  // 初始化成功:进入受保护主页(refresh 后会话已就绪)
  if (done) {
    return <Navigate to="/" replace />;
  }
  // 已初始化:向导不再可用,转登录页
  if (initialized) {
    return <Navigate to="/login" replace />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xl font-semibold tracking-[0.3em] text-accent">HOME MEDIA</p>
          <p className="mt-2 text-sm text-muted">家庭媒体平台 · 初始化向导</p>
        </header>

        <Card>
          <Card.Header>
            <Card.Title>创建你的家庭</Card.Title>
            <Card.Description>
              首次启动:创建家庭与主账号,完成后将自动登录。
            </Card.Description>
          </Card.Header>
          <Card.Content>
            {checking ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <Spinner size="lg" />
                <p className="text-sm text-muted">正在检查初始化状态…</p>
              </div>
            ) : checkError ? (
              <div className="flex flex-col gap-4">
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>状态检查失败</Alert.Title>
                    <Alert.Description>{checkError}</Alert.Description>
                  </Alert.Content>
                </Alert>
                <Button variant="outline" onPress={() => void checkStatus()}>
                  重试
                </Button>
              </div>
            ) : (
              <Form className="flex flex-col gap-4" onSubmit={onSubmit} validationBehavior="aria">
                <TextField
                  value={values.householdName}
                  onChange={setField('householdName')}
                  isInvalid={fieldErrors.householdName !== undefined}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoComplete="organization"
                >
                  <Label>家庭名称</Label>
                  <Input type="text" placeholder="例如:我的家" />
                  <FieldError>{fieldErrors.householdName}</FieldError>
                </TextField>

                <TextField
                  value={values.username}
                  onChange={setField('username')}
                  isInvalid={fieldErrors.username !== undefined}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoComplete="username"
                >
                  <Label>用户名</Label>
                  <Input type="text" placeholder="3-64 个字符" />
                  <FieldError>{fieldErrors.username}</FieldError>
                </TextField>

                <TextField
                  value={values.password}
                  onChange={setField('password')}
                  isInvalid={fieldErrors.password !== undefined}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoComplete="new-password"
                >
                  <Label>密码</Label>
                  <Input type="password" placeholder="至少 8 位" />
                  <FieldError>{fieldErrors.password}</FieldError>
                </TextField>

                <TextField
                  value={values.confirmPassword}
                  onChange={setField('confirmPassword')}
                  isInvalid={fieldErrors.confirmPassword !== undefined}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoComplete="new-password"
                >
                  <Label>确认密码</Label>
                  <Input type="password" placeholder="再次输入密码" />
                  <FieldError>{fieldErrors.confirmPassword}</FieldError>
                </TextField>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    value={values.defaultLanguage}
                    onChange={setField('defaultLanguage')}
                    validationBehavior="aria"
                    fullWidth
                  >
                    <Label>默认语言(可选)</Label>
                    <Input type="text" placeholder="zh-CN" />
                  </TextField>
                  <TextField
                    value={values.timezone}
                    onChange={setField('timezone')}
                    validationBehavior="aria"
                    fullWidth
                  >
                    <Label>时区(可选)</Label>
                    <Input type="text" placeholder="Asia/Shanghai" />
                  </TextField>
                </div>

                {submitError && (
                  <Alert status={submitError.alreadyInitialized ? 'warning' : 'danger'}>
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>{submitError.title}</Alert.Title>
                      {submitError.description && (
                        <Alert.Description>{submitError.description}</Alert.Description>
                      )}
                    </Alert.Content>
                  </Alert>
                )}
                {submitError?.alreadyInitialized && (
                  <Link
                    to="/login"
                    className="inline-flex min-h-11 items-center justify-center text-sm font-medium text-danger underline-offset-4 hover:underline"
                  >
                    前往登录 →
                  </Link>
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
                      初始化中…
                    </>
                  ) : (
                    '完成初始化'
                  )}
                </Button>
              </Form>
            )}
          </Card.Content>
        </Card>
      </div>
    </main>
  );
}
