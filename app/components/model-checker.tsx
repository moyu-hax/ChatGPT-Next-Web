import { useEffect, useState } from "react";

import { LLMModel } from "../client/api";
import { ServiceProvider } from "../constant";
import ConnectionIcon from "../icons/connection.svg";
import ConfirmIcon from "../icons/confirm.svg";
import CloseIcon from "../icons/close.svg";
import DeleteIcon from "../icons/delete.svg";
import LoadingIcon from "../icons/three-dots.svg";
import ReloadIcon from "../icons/reload.svg";
import Locale from "../locales";
import { useAccessStore, useAppConfig } from "../store";
import {
  CustomModelGroup,
  getCustomModelGroupProviderId,
} from "../store/config";
import {
  checkProviderModel,
  checkProviderModels,
  fetchProviderModels,
  ModelCheckResult,
} from "../utils/model-check";
import { IconButton } from "./button";
import { ListItem, showConfirm, showToast } from "./ui-lib";

import styles from "./model-checker.module.scss";

type CheckStatus = "idle" | "checking" | "available" | "unavailable";

type CheckState = {
  status: CheckStatus;
  result?: ModelCheckResult;
};

const PROVIDER = ServiceProvider.OpenAI;

export function AccessCodeModelChecker() {
  const config = useAppConfig();
  const [groupName, setGroupName] = useState("");
  const [loadedGroupName, setLoadedGroupName] = useState("");
  const [loadedGroup, setLoadedGroup] = useState<CustomModelGroup>();
  const [models, setModels] = useState<LLMModel[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [loadingModels, setLoadingModels] = useState(false);
  const [checkingModel, setCheckingModel] = useState<string>();
  const [checkingAll, setCheckingAll] = useState(false);

  const isBusy = loadingModels || checkingAll || !!checkingModel;
  const normalizedGroupName = groupName.trim();
  const accessStore = useAccessStore();
  const isBuiltinGroupName = Object.values(ServiceProvider).some(
    (provider) => provider.toLowerCase() === normalizedGroupName.toLowerCase(),
  );
  const isDuplicateGroupName = config.customModelGroups.some(
    (group) => group.name.toLowerCase() === normalizedGroupName.toLowerCase(),
  );
  const canFetchModels =
    normalizedGroupName.length > 0 &&
    !isBuiltinGroupName &&
    !isDuplicateGroupName;

  const getCurrentGroup = (): CustomModelGroup => ({
    name: normalizedGroupName,
    providerId: getCustomModelGroupProviderId(normalizedGroupName),
    source: accessStore.useCustomConfig ? "custom" : "access-code",
    accessCode: accessStore.useCustomConfig
      ? undefined
      : accessStore.accessCode,
    openaiUrl: accessStore.useCustomConfig ? accessStore.openaiUrl : undefined,
    openaiApiKey: accessStore.useCustomConfig
      ? accessStore.openaiApiKey
      : undefined,
    models: models.map((model) => model.name),
  });

  useEffect(() => {
    if (
      loadedGroup &&
      !config.customModelGroups.some(
        (group) => group.providerId === loadedGroup.providerId,
      )
    ) {
      setLoadedGroup(undefined);
      setLoadedGroupName("");
      setModels([]);
      setChecks({});
    }
  }, [config.customModelGroups, loadedGroup]);

  const updateCheck = (model: string, result: ModelCheckResult) => {
    setChecks((current) => ({
      ...current,
      [model]: {
        status: result.available ? "available" : "unavailable",
        result,
      },
    }));
  };

  const fetchModels = async () => {
    if (!canFetchModels) return;

    setLoadingModels(true);
    try {
      const providerId = getCustomModelGroupProviderId(normalizedGroupName);
      const group = getCurrentGroup();
      const fetchedModels = await fetchProviderModels(PROVIDER, group);
      const groupedModels = fetchedModels.map((model) => ({
        ...model,
        provider: {
          id: providerId,
          providerName: normalizedGroupName,
          providerType: "custom",
          sorted: 100,
        },
      }));

      setModels(groupedModels);
      setLoadedGroupName(normalizedGroupName);
      setChecks({});
      config.mergeModels(groupedModels, normalizedGroupName);
      config.upsertCustomModelGroup({
        ...group,
        models: groupedModels.map((model) => model.name),
      });
      setLoadedGroup({
        ...group,
        models: groupedModels.map((model) => model.name),
      });
      setGroupName("");
      showToast(Locale.Settings.ModelCheck.Found(groupedModels.length));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showToast(`${Locale.Settings.ModelCheck.FetchFailed}: ${detail}`);
    } finally {
      setLoadingModels(false);
    }
  };

  const checkOne = async (model: string) => {
    setCheckingModel(model);
    setChecks((current) => ({
      ...current,
      [model]: { status: "checking" },
    }));

    try {
      updateCheck(
        model,
        await checkProviderModel(PROVIDER, model, 30000, loadedGroup),
      );
    } finally {
      setCheckingModel(undefined);
    }
  };

  const checkAll = async () => {
    const modelNames = models.map((model) => model.name);
    let availableCount = 0;
    setCheckingAll(true);
    setChecks(
      Object.fromEntries(
        modelNames.map((model) => [model, { status: "checking" }]),
      ) as Record<string, CheckState>,
    );

    try {
      await checkProviderModels(
        PROVIDER,
        modelNames,
        (model, result) => {
          if (result.available) availableCount += 1;
          updateCheck(model, result);
        },
        3,
        loadedGroup,
      );
      showToast(
        Locale.Settings.ModelCheck.BatchComplete(
          availableCount,
          modelNames.length,
        ),
      );
    } finally {
      setCheckingAll(false);
    }
  };

  const getStatusText = (state?: CheckState) => {
    if (!state || state.status === "idle") {
      return Locale.Settings.ModelCheck.Untested;
    }
    if (state.status === "checking") {
      return Locale.Settings.ModelCheck.Checking;
    }
    if (state.status === "available") {
      return `${Locale.Settings.ModelCheck.Available} (${
        state.result?.latency ?? 0
      } ms)`;
    }
    if (state.result?.error === "timeout") {
      return Locale.Settings.ModelCheck.Timeout;
    }
    if (state.result?.error === "invalid_response") {
      return Locale.Settings.ModelCheck.InvalidResponse;
    }
    return state.result?.error || Locale.Settings.ModelCheck.Unavailable;
  };

  return (
    <ListItem
      title={Locale.Settings.ModelCheck.Title}
      subTitle={
        models.length > 0
          ? Locale.Settings.ModelCheck.GroupCount(
              loadedGroupName,
              models.length,
            )
          : Locale.Settings.ModelCheck.SubTitle
      }
      vertical
    >
      <div className={styles["model-checker"]}>
        <label className={styles["model-checker-group"]}>
          <span>{Locale.Settings.ModelCheck.GroupName}</span>
          <input
            type="text"
            value={groupName}
            placeholder={Locale.Settings.ModelCheck.GroupNamePlaceholder}
            onChange={(event) =>
              setGroupName(event.currentTarget.value.replaceAll("@", ""))
            }
            disabled={isBusy}
          />
          <small>
            {isBuiltinGroupName
              ? Locale.Settings.ModelCheck.GroupNameBuiltin
              : isDuplicateGroupName
              ? Locale.Settings.ModelCheck.GroupNameDuplicate
              : Locale.Settings.ModelCheck.GroupNameHint}
          </small>
        </label>

        <div className={styles["model-checker-actions"]}>
          <IconButton
            icon={loadingModels ? <LoadingIcon /> : <ReloadIcon />}
            text={
              loadingModels
                ? Locale.Settings.ModelCheck.Fetching
                : Locale.Settings.ModelCheck.Fetch
            }
            onClick={fetchModels}
            disabled={isBusy || !canFetchModels}
            bordered
          />
          <IconButton
            icon={checkingAll ? <LoadingIcon /> : <ConnectionIcon />}
            text={
              checkingAll
                ? Locale.Settings.ModelCheck.Checking
                : Locale.Settings.ModelCheck.BatchCheck
            }
            onClick={checkAll}
            disabled={isBusy || models.length === 0}
            bordered
          />
        </div>

        {models.length === 0 ? (
          <div className={styles["model-checker-empty"]}>
            {Locale.Settings.ModelCheck.Empty}
          </div>
        ) : (
          <div className={styles["model-checker-list"]}>
            {models.map((model) => {
              const state = checks[model.name];
              const isChecking = state?.status === "checking";
              return (
                <div className={styles["model-checker-item"]} key={model.name}>
                  <div className={styles["model-checker-info"]}>
                    <div className={styles["model-checker-name"]}>
                      {model.displayName || model.name}
                    </div>
                    <div
                      className={
                        styles[
                          `model-checker-status-${state?.status || "idle"}`
                        ]
                      }
                      title={getStatusText(state)}
                    >
                      {state?.status === "available" && <ConfirmIcon />}
                      {state?.status === "unavailable" && <CloseIcon />}
                      {isChecking && <LoadingIcon />}
                      <span>{getStatusText(state)}</span>
                    </div>
                  </div>
                  <IconButton
                    icon={isChecking ? <LoadingIcon /> : <ConnectionIcon />}
                    text={Locale.Settings.ModelCheck.Check}
                    onClick={() => checkOne(model.name)}
                    disabled={isBusy}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ListItem>
  );
}

export function CustomModelGroupList() {
  const config = useAppConfig();

  return (
    <ListItem
      title={Locale.Settings.ModelCheck.SavedGroups}
      subTitle={Locale.Settings.ModelCheck.SavedGroupsSubTitle}
      vertical
    >
      <div className={styles["model-group-list"]}>
        {config.customModelGroups.length === 0 ? (
          <div className={styles["model-checker-empty"]}>
            {Locale.Settings.ModelCheck.NoSavedGroups}
          </div>
        ) : (
          config.customModelGroups.map((group) => (
            <div className={styles["model-group-item"]} key={group.providerId}>
              <div className={styles["model-checker-info"]}>
                <div className={styles["model-checker-name"]}>{group.name}</div>
                <div className={styles["model-group-detail"]}>
                  {Locale.Settings.ModelCheck.GroupDetail(
                    group.models.length,
                    group.source === "custom"
                      ? Locale.Settings.ModelCheck.CustomChannel
                      : Locale.Settings.ModelCheck.AccessCodeChannel,
                    group.source === "custom" ? group.openaiUrl : undefined,
                  )}
                </div>
              </div>
              <IconButton
                icon={<DeleteIcon />}
                text={Locale.Settings.ModelCheck.DeleteGroup}
                onClick={async () => {
                  if (
                    await showConfirm(
                      Locale.Settings.ModelCheck.DeleteGroupConfirm(group.name),
                    )
                  ) {
                    config.deleteCustomModelGroup(group.name);
                  }
                }}
              />
            </div>
          ))
        )}
      </div>
    </ListItem>
  );
}
