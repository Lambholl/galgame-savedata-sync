/**
 * 设置表单的统一排版：标签左对齐、不带冒号，控件紧跟标签。
 * 宽度交给栅格列：下拉框 200px，数字框 132px，开关不受影响。
 */
export const SETTING_FORM = {
  labelCol: { flex: '160px' },
  wrapperCol: { flex: '0 0 200px' },
  labelAlign: 'left',
  colon: false,
} as const

/** 数字输入框所在的列宽。 */
export const NUMBER_FIELD = { flex: '0 0 132px' } as const
