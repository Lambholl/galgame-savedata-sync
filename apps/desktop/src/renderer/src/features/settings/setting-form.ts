/**
 * 设置表单的统一排版：标签居左，允许换行；控件居右，标签后不加冒号。
 * 数字框单独限宽，选择器随设置行的可用宽度收缩。
 */
export const SETTING_FORM = {
  className: 'settings-form',
  labelCol: { flex: '1 1 0' },
  wrapperCol: { flex: '0 1 auto' },
  labelAlign: 'left',
  labelWrap: true,
  colon: false,
} as const

/** 数字输入框所在的列宽。 */
export const NUMBER_FIELD = { flex: '0 0 132px' } as const
