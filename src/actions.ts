import {
    CompanionActionDefinition,
    CompanionActionDefinitions,
    CompanionActionEvent,
    CompanionActionInfo,
    CompanionInputFieldCheckbox,
    CompanionInputFieldDropdown,
    CompanionInputFieldNumber,
    CompanionInputFieldTextInput,
    DropdownChoice,
    InputValue,
    SomeCompanionActionInputField,
} from "@companion-module/base";
import { commandParameterTypeToInputType, getRequestMethod, transformDotCaseToTitleCase } from "./utils";
import StreamStudioInstance from "./index";
import { Option, Options } from "./types/options";
import { RequestMethod } from "./types/apiDefinition";
import { NotificationTypes, ParameterType, Request, RequestDefinition, RequestParameter } from "studio-api-client";
import { CompanionCommonCallbackContext } from "@companion-module/base/dist/module-api/common";
import { CompanionControlType } from "./types/stateStore";

const GROUPS_TO_SKIP = ["frontend"];

const COMMAND_PARMS_TYPES_WITHOUT_OPTIONS_TO_GET: ParameterType[] = ["boolean", "string", "number", "select"];

export const getParameterTopic = (requestType: string, paramId: string) => {
    return `${requestType}/${paramId}`;
};

const DEFAULT_CHOICE_ID = "default_option";
const defaultChoice: DropdownChoice = {
    id: DEFAULT_CHOICE_ID,
    label: "Select an option...",
};

export const convertParamOptionsToChoices = <T>(options: Option[] | T[]): DropdownChoice[] => {
    if (options.length === 0) return [defaultChoice];
    if (["string", "number"].includes(typeof options[0])) {
        return [
            defaultChoice,
            ...options.map((option) => {
                const stringOption = typeof option === "string" ? option : (option as number).toString();
                return { id: stringOption, label: stringOption };
            }),
        ];
    }
    return [
        defaultChoice,
        ...options.map((option) => {
            const typedOption = option as Option;
            return {
                id: typeof typedOption.id === "undefined" ? "undefined" : typedOption.id,
                label: typedOption.value,
            };
        }),
    ];
};

const getChoices = <T>(
    param: RequestParameter<T>,
    requestType: string,
    availableOptions: Options
): DropdownChoice[] => {
    if (param.type === "select" && param.values) return convertParamOptionsToChoices(param.values);
    const topic = getParameterTopic(requestType, param.id);
    if (typeof availableOptions[topic] !== "undefined") return convertParamOptionsToChoices(availableOptions[topic]);
    return [{ id: 0, label: "No options available." }];
};

const getInput = <T>(
    param: RequestParameter<T>,
    setRequest: RequestDefinition,
    ssInstance: StreamStudioInstance
): SomeCompanionActionInputField => {
    const inputType = commandParameterTypeToInputType(param.type);
    switch (inputType) {
        case "number": {
            const label = param.range
                ? `${param.prettyName} (min ${param.range.min}, max ${param.range.max})`
                : param.prettyName;
            const input: CompanionInputFieldNumber = {
                type: "number",
                id: param.id,
                label,
                default: typeof param.defaultValue === "number" ? param.defaultValue : 0,
                min: (param.range?.min as number) || 0,
                max: (param.range?.max as number) || 0,
            };
            return input;
        }
        case "textinput": {
            const input: CompanionInputFieldTextInput = {
                type: "textinput",
                id: param.id,
                label: param.prettyName,
                default: typeof param.defaultValue === "string" ? param.defaultValue : undefined,
            };
            return input;
        }
        case "checkbox": {
            const input: CompanionInputFieldCheckbox = {
                type: "checkbox",
                id: param.id,
                label: param.prettyName,
                default: typeof param.defaultValue === "boolean" ? param.defaultValue : false,
            };
            return input;
        }
        case "dropdown": {
            const choices = getChoices(param, setRequest.requestType, ssInstance.options);
            const input: CompanionInputFieldDropdown = {
                type: "dropdown",
                id: param.id,
                label: `${param.prettyName}${param.property === "required" ? " (required)" : ""}`,
                choices,
                default: DEFAULT_CHOICE_ID,
            };
            return input;
        }
    }
};

const getCallback = (request: RequestDefinition, ssInstance: StreamStudioInstance) => {
    return (action: CompanionActionEvent, _context: CompanionCommonCallbackContext) => {
        const message: any = {
            "request-type": request.requestType,
        };

        let requiredParamNotSet = false;
        ssInstance.log("debug", "state");
        ssInstance.log("debug", JSON.stringify(ssInstance.state));

        request?.requestParams?.forEach((param) => {
            const { id, type, property, defaultValue } = param;
            if (type === "boolean") {
                if (!["controllable", "required"].includes(property)) {
                    return;
                }
                const value = !ssInstance.state[action.controlId].value;
                message[id] = value;
                return;
            }
            let value = action.options[id] as InputValue;
            if (typeof value === "undefined") {
                // Handling required const parameters
                if (property !== "required") return;
                if (defaultValue) value = defaultValue;
            }
            if (value === DEFAULT_CHOICE_ID) {
                if (property === "required") {
                    requiredParamNotSet = true;
                }
                return;
            }
            message[id] = value;
        });

        if (requiredParamNotSet) {
            ssInstance.log(
                "error",
                `Executing ${request.requestType}: command aborted because not all required parameters are set.`
            );
            return;
        }

        ssInstance.sendRequest(message);
    };
};

const generateActions = (ssInstance: StreamStudioInstance): CompanionActionDefinitions => {
    const actions: CompanionActionDefinitions = {};
    const { apiDefinition } = ssInstance;
    if (!apiDefinition) return actions;
    for (const [key, value] of Object.entries(apiDefinition)) {
        if (GROUPS_TO_SKIP.includes(key)) continue;
        const group = {
            name: transformDotCaseToTitleCase(key),
            id: key,
            requests: value,
        };

        group.requests.forEach((request) => {
            const { requestType, requestParams, hidden } = request;

            if (hidden) return;

            const method = getRequestMethod(requestType);

            if (method !== RequestMethod.SET) return;

            const options: SomeCompanionActionInputField[] = [];
            requestParams?.forEach((param) => {
                const { type, property } = param;
                if (["controllable", "required"].includes(property) && type === "boolean") {
                    return;
                }
                options.push(getInput(param, request, ssInstance));
            });

            const getRequestType = `${requestType.substring(0, requestType.length - 3)}get`;

            const getRequest = group.requests.find((request) => request.requestType === getRequestType);
            if (!getRequest) return;

            const action: CompanionActionDefinition = {
                name: `${group.name}: ${request.pretty_name}`,
                options: options,
                callback: getCallback(request, ssInstance),
                subscribe: (action: CompanionActionInfo) => {
                    ssInstance.log("debug", JSON.stringify(getRequest));
                    request?.requestParams?.forEach((param) => {
                        ssInstance.log("debug", JSON.stringify(action.options));
                        if (param.type === "boolean" && ["controllable", "required"].includes(param.property)) {
                            ssInstance.log("debug", "adding state entry");
                            ssInstance.log(
                                "debug",
                                JSON.stringify({
                                    requestType: request.requestType,
                                    paramId: param.id,
                                    value: DEFAULT_CHOICE_ID,
                                    paramValues: action.options,
                                    companionId: action.actionId,
                                    controlType: CompanionControlType.ACTION,
                                })
                            );
                            // Add state entry
                            ssInstance.state[action.controlId] = {
                                requestType: request.requestType,
                                paramId: param.id,
                                value: DEFAULT_CHOICE_ID,
                                paramValues: action.options,
                                companionId: action.actionId,
                                controlType: CompanionControlType.ACTION,
                            };

                            // Get initial value
                            const message: Record<string, InputValue> = {
                                "request-type": getRequest.requestType,
                            };
                            let areAllParametersSet = true;
                            getRequest.requestParams?.forEach((param) => {
                                ssInstance.log("debug", `${param.id}: ${action.options[param.id]}`);

                                const value = action.options[param.id] as InputValue;
                                if (value === DEFAULT_CHOICE_ID) areAllParametersSet = false;
                                message[param.id] = value;
                            });

                            if (areAllParametersSet) {
                                ssInstance.sendValueRequest(
                                    message as Request,
                                    action.controlId,
                                    action.actionId,
                                    param.id,
                                    action.options,
                                    CompanionControlType.ACTION
                                );
                            }

                            // Subscribe to notifications
                            ssInstance.addListenedUpdate(request.requestType as NotificationTypes, action.controlId);
                        }

                        if (COMMAND_PARMS_TYPES_WITHOUT_OPTIONS_TO_GET.includes(param.type)) return;
                        ssInstance.getOptions(requestType, param.id);
                    });
                },
                unsubscribe: (action: CompanionActionInfo) => {
                    ssInstance.removeListenedUpdate(action.controlId);
                    ssInstance.removeListenedUpdate(action.controlId);
                    delete ssInstance.state[action.controlId];
                },
            };

            actions[request.requestType] = action;
        });
    }

    return actions;
};

export default generateActions;
