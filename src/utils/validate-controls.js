'use strict'

import { ControlMode, parseYAML, reverseTemplate } from './source-utils'
import _ from 'lodash'

///////////////////////////////////////////////////////////////////////////////
// validate control/source values
///////////////////////////////////////////////////////////////////////////////

export function validateControls(
  editors,
  templateYAML,
  otherYAMLTabs = [],
  controlData,
  isFinalValidate,
  i18n
) {
  // parse all yamls
  const results = parseYAML(templateYAML)
  let { parsed, exceptions } = results
  const { resources } = results

  // update active values in controls
  if (exceptions.length === 0) {
    reverseTemplate(controlData, parsed, null, i18n)
  }

  const templateObjectMap = { '<<main>>': parsed }
  const templateExceptionMap = {
    '<<main>>': {
      editor: editors[0],
      exceptions: attachEditorToExceptions(exceptions, editors, 0)
    }
  }
  otherYAMLTabs.forEach(({ id, templateYAML: yaml }, inx) => {
    ({ parsed, exceptions } = parseYAML(yaml))
    templateObjectMap[id] = parsed
    templateExceptionMap[id] = {
      editor: editors[inx + 1],
      exceptions: attachEditorToExceptions(exceptions, editors, inx + 1)
    }
  })

  // if any syntax errors, report them and leave
  let hasSyntaxExceptions = false
  Object.values(templateExceptionMap).forEach(({ exceptions: _exceptions }) => {
    if (_exceptions.length > 0) {
      hasSyntaxExceptions = true
    }
  })

  // get values from parsed yamls using source paths and verify values are valid
  if (!hasSyntaxExceptions) {
    let stopValidating = false
    controlData.forEach(control => {
      const {
        type,
        active = [],
        pauseControlCreationHereUntilSelected
      } = control
      delete control.exception
      if (!stopValidating) {
        switch (type) {
        case 'group':
          validateGroupControl(
            active,
            controlData,
            templateObjectMap,
            templateExceptionMap,
            isFinalValidate,
            i18n
          )
          break

        case 'table':
          control.exceptions = []
          validateTableControl(
            control,
            templateObjectMap,
            templateExceptionMap,
            isFinalValidate,
            i18n
          )
          break

        default:
          validateControl(
            control,
            controlData,
            templateObjectMap,
            templateExceptionMap,
            isFinalValidate,
            i18n
          )
          break
        }
      }
      if (pauseControlCreationHereUntilSelected) {
        stopValidating = !active
      }
    })
  }

  // update editors with any format exceptions
  let hasValidationExceptions = false
  Object.values(templateExceptionMap).forEach(
    ({ editor, exceptions: _exceptions }, inx) => {
      setTimeout(() => {
        if (editor) {
          const decorationList = []
          _exceptions.forEach(({ row = 1, text }) => {
            decorationList.push({
              range: new editor.monaco.Range(row, 0, row, 132),
              options: {
                isWholeLine: true,
                glyphMarginClassName: 'errorDecoration',
                glyphMarginHoverMessage: { value: text },
                minimap: { color: 'red', position: 1 }
              }
            })
          })
          _exceptions.forEach(({ row = 1, column = 0 }) => {
            decorationList.push({
              range: new editor.monaco.Range(row, column - 6, row, column + 6),
              options: {
                className: 'squiggly-error'
              }
            })
          })
          editor.errorList = decorationList
          editor.decorations = editor.deltaDecorations(editor.decorations, [
            ...editor.errorList,
            ...(editor.changeList || [])
          ])
        }
      }, 0)
      if (_exceptions.length > 0) {
        hasValidationExceptions = true
        attachEditorToExceptions(_exceptions, editors, inx)
      }
    }
  )
  return {
    templateObjectMap,
    templateExceptionMap,
    parsedResources: resources,
    hasSyntaxExceptions,
    hasValidationExceptions
  }
}

const validateGroupControl = (
  group,
  parentControlData,
  templateObjectMap,
  templateExceptionMap,
  isFinalValidate,
  i18n
) => {
  group.forEach(controlData => {
    controlData.forEach(control => {
      delete control.exception
      validateControl(
        control,
        parentControlData,
        templateObjectMap,
        templateExceptionMap,
        isFinalValidate,
        i18n
      )
    })
  })
}

const validateTableControl = (
  table,
  templateObjectMap,
  templateExceptionMap,
  isFinalValidate,
  i18n
) => {
  const {
    active: rows,
    controlData,
    //sourcePath: { tabId = '<<main>>', paths },
    validation: { tester },
    exceptions
  } = table
  const controlDataMap = _.keyBy(controlData, 'id')
  let hidden = false
  rows.forEach((row) => {
    //const pathMap = paths[inx]
    Object.entries(row).forEach(([key, active]) => {
      if (
        controlDataMap[key] &&
        (typeof active !== 'string' || !active.trim().startsWith('#'))
      ) {
        const control = {
          ...controlDataMap[key],
          //sourcePath: { tabId, path: pathMap ? pathMap[key] : '' },
          active
        }
        validateControl(
          control,
          controlData,
          templateObjectMap,
          templateExceptionMap,
          isFinalValidate,
          i18n
        )
        row[key] = control.active
        const promptOnly = control.mode === ControlMode.PROMPT_ONLY
        if (control.exception) {
          // add exception to cell in table
          let exception = exceptions.find(
            ({ exception: _exception }) => _exception === control.exception
          )
          if (!exception) {
            exception = {
              exception: control.exception,
              cells: []
            }
            exceptions.push(exception)
          }
          if (!promptOnly) {
            exception.cells.push(`${key}-${row.id}`)
          } else {
            hidden = true
          }
        }
      }
    })
  })
  if (exceptions.length > 0) {
    table.exception = i18n(
      `creation.ocp.validation.errors${hidden ? '.hidden' : ''}`)
  } else if (typeof tester === 'function') {
    const exception = tester(rows)
    if (exception) {
      table.exception = i18n(exception)
    }
  }
}

const validateControl = (
  control,
  controlData,
  templateObjectMap,
  templateExceptionMap,
  isFinalValidate,
  i18n
) => {
  // if final validation before creating template, if this value is required, throw error
  const { type, isHidden } = control
  if (
    isHidden === true ||
    isHidden === 'true' ||
    (typeof isHidden === 'function' && isHidden())
  ) {
    return
  }
  if ((isFinalValidate || type === 'number') && control.validation) {
    const { exceptions } = templateExceptionMap['<<main>>']
    if (type === 'custom') {
      control.validation(exceptions)
      return
    } else {
      const {
        name,
        active,
        validation: { required, notification },
        controlId,
        ref
      } = control
      if (required && (!active || (type === 'cards' && active.length === 0))) {
        let row = 0
        const msg = notification ? notification : 'creation.missing.input'
        control.exception = i18n(msg, [name])
        const { sourcePath } = control
        if (sourcePath) {
          //({ exceptions } = templateExceptionMap[tabId])
          row = getRow(sourcePath)
        }
        exceptions.push({
          row,
          column: 0,
          text: control.exception,
          type: 'error',
          controlId,
          ref
        })
        return
      }
    }
  }

  if (shouldValidateControl(control)) {
    switch (control.type) {
    case 'text':
    case 'textarea':
    case 'number':
    case 'combobox':
    case 'toggle':
    case 'hidden':
      validateTextControl(
        control,
        templateObjectMap,
        templateExceptionMap,
        isFinalValidate,
        i18n
      )
      break
    case 'checkbox':
      validateCheckboxControl(
        control,
        templateObjectMap,
        templateExceptionMap,
        i18n
      )
      break
    case 'cards':
      validateCardsControl(
        control,
        templateObjectMap,
        templateExceptionMap,
        i18n
      )
      break
    case 'singleselect':
      validateSingleSelectControl(
        control,
        templateObjectMap,
        templateExceptionMap,
        i18n
      )
      break
    case 'multiselect':
      validateMultiSelectControl(
        control,
        templateObjectMap,
        templateExceptionMap,
        i18n
      )
      break
    case 'table':
      validateTableControl(
        control,
        templateObjectMap,
        templateExceptionMap,
        i18n
      )
      break
    }
  }
}

const attachEditorToExceptions = (exceptions, editors, inx) => {
  return exceptions.map(exception => {
    exception.editor = editors[inx]
    exception.tabInx = inx
    return exception
  })
}

const shouldValidateControl = control => {
  let required = false
  const { sourcePath, validation, active } = control
  if (sourcePath && validation) {
    ({ required } = validation)
    if (!required) {
      // if not required, only validate if that yaml path exists
      return !!active
    }
  }
  return required
}

const validateTextControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  isFinalValidate,
  i18n
) => {
  const {
    id,
    name,
    sourcePath,
    validation: { contextTester, tester, notification },
    template,
    controlId,
    ref
  } = control
  let active = control.active
  if (typeof active === 'number') {
    active = active.toString()
  }
  // ex: text input is in the form of a uri
  if (active && template) {
    const parts = template.split(`{{{${id}}}}`)
    active = active.replace(parts[0], '')
    if (parts.length > 1) {
      active = active.replace(new RegExp(parts[1] + '$'), '')
    }
  }
  control.active = active
  const { exceptions } = templateExceptionMap['<<main>>']
  if (active === undefined) {
    addException(sourcePath, exceptions, i18n)
  } else if (active || isFinalValidate) {
    let exception
    if (active) {
      if (contextTester) {
        exception = contextTester(active, templateObjectMap, i18n)
      } else if (tester && !tester.test(active)) {
        if (active.length > 50) {
          active = `${active.substr(0, 25)}...${active.substr(-25)}`
        }
        exception = i18n(notification, [active])
      }
    } else {
      exception = i18n('validation.missing.value', [name])
    }
    if (exception) {
      control.exception = exception
      exceptions.push({
        row: getRow(sourcePath),
        column: 0,
        text: exception,
        type: 'error',
        controlId,
        ref
      })
    }
  }
  if (tester) {
    tester.lastIndex = 0
  }
}

const validateSingleSelectControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { active, available = [], sourcePath = {} } = control
  const { exceptions } = templateExceptionMap['<<main>>']
  if (!active) {
    addException(sourcePath, exceptions, i18n)
  } else if (
    available.findIndex(avail => active.indexOf(avail) !== -1) === -1
  ) {
    control.exception = i18n(
      'validation.bad.value',
      [active, _.get(control, 'available')])
    exceptions.push({
      row: getRow(sourcePath),
      column: 0,
      text: control.exception,
      type: 'error'
    })
  }
}

const validateCardsControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { active, validation: { required, notification } } = control
  if (required && !active) {
    control.exception = i18n(notification)
  }
}

const validateCheckboxControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { active, available, sourcePath } = control
  const { exceptions } = templateExceptionMap['<<main>>']
  if (!active) {
    addException(sourcePath, exceptions, i18n)
  }
  if (available.indexOf(active) === -1) {
    control.exception = i18n(
      'validation.bad.value',
      [getKey(''), available.join(', ')])
    exceptions.push({
      row: getRow(sourcePath),
      column: 0,
      text: control.exception,
      type: 'error'
    })
  }
}

const validateMultiSelectControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { hasKeyLabels, hasReplacements } = control
  if (hasKeyLabels) {
    validateMultiSelectLabelControl(
      control,
      templateObjectMap,
      templateExceptionMap,
      i18n
    )
  } else if (hasReplacements) {
    validateMultiSelectReplacementControl(
      control,
      templateObjectMap,
      templateExceptionMap,
      i18n
    )
  } else {
    validateMultiSelectStringControl(
      control,
      templateObjectMap,
      templateExceptionMap,
      i18n
    )
  }
}

const validateMultiSelectStringControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { active, sourcePath } = control
  const { exceptions } = templateExceptionMap['<<main>>']
  if (active === null) {
    addException(sourcePath, exceptions, i18n)
  }
}

const validateMultiSelectLabelControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { active, sourcePath } = control
  const { exceptions } = templateExceptionMap['<<main>>']
  if (!active) {
    addException(sourcePath, exceptions, i18n)
  }
}

const validateMultiSelectReplacementControl = (
  control,
  templateObjectMap,
  templateExceptionMap,
  i18n
) => {
  const { active, sourcePath } = control
  const { exceptions } = templateExceptionMap['<<main>>']
  if (!active) {
    addException(sourcePath, exceptions, i18n)
  }
}

const addException = (sourcePath, exceptions, i18n) => {
  exceptions.push({
    row: getRow(sourcePath),
    column: 0,
    text: i18n('validation.missing.resource'),
    type: 'error'
  })
}

const getKey = path => {
  return path
    .join('.')
    .replace('.$synced', '')
    .replace('[0]', '')
    .replace(/\.\$v/g, '')
}

const getRow = sourcePath => {
  return _.get(sourcePath, '$r', 0) + 1
}